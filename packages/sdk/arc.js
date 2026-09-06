// @verdikt/sdk/arc — the only file that knows the Arc registry's ABI.
//
// Same choke-point argument as `ens.js`: the proxy, the dashboard and the seed
// scripts all need registry state, and none of them should hold a copy of the
// ABI or the log-scanning rules. The marketplace reads services straight off
// RPC logs with no subgraph (Specification.md §3, §5), so the scanning is here
// too rather than in the dashboard.

import { createPublicClient, defineChain, http, parseAbi } from 'viem';
import { outcomeFromOrdinal, statusFromOrdinal } from './registry.js';

/**
 * Arc Testnet. USDC is the native gas token, which is why value moves as
 * `msg.value` and escrow holds it directly (Specification.md §3, §6).
 *
 * `nativeCurrency.decimals` is 18 — Arc exposes the same USDC twice, 18
 * decimals natively (gas, `msg.value`) and 6 as the ERC-20 view that x402 pays
 * in. Everything in this SDK past `decodePayment` is in the 6-decimal view;
 * `VerdiktRegistry.NATIVE_PER_MINOR_UNIT` is the only conversion.
 *
 * Chain id from the spike's own `eth_chainId` against
 * `https://rpc.testnet.arc.network` (0x4cef52), not from a table.
 */
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } }
});

export const DEFAULT_ARC_RPC = arcTestnet.rpcUrls.default.http[0];

/**
 * The registry surface consumers actually read. Deliberately not the whole
 * ABI: `register`, `topUp` and `deregister` are provider actions, and
 * `onReport` belongs to the forwarder.
 */
export const registryAbi = parseAbi([
  'function getService(bytes32 serviceId) view returns ((address provider, uint8 status, uint256 deposit))',
  'function getVerdict(bytes32 requestId) view returns ((bytes32 serviceId, uint8 outcome, address payer, uint256 paidAmount, uint256 refundCredited, uint64 writtenAt))',
  'function getOwed(address payer) view returns (uint256)',
  'function DEPOSIT_AMOUNT() view returns (uint256)',
  'function FIXED_REFUND() view returns (uint256)',
  'function NATIVE_PER_MINOR_UNIT() view returns (uint256)',
  'event ServiceRegistered(bytes32 indexed serviceId, address indexed provider, string slug, uint256 deposit)',
  'event VerdictWritten(bytes32 indexed serviceId, bytes32 indexed requestId, uint8 outcome, address payer, uint256 paidAmount)',
  'event RefundCredited(bytes32 indexed serviceId, bytes32 indexed requestId, address indexed payer, uint256 amount)',
  'event ServiceSuspended(bytes32 indexed serviceId)',
  'event ServiceReinstated(bytes32 indexed serviceId, uint256 deposit)',
  'event ServiceDeregistered(bytes32 indexed serviceId, address indexed provider, uint256 returnedDeposit)'
]);

/**
 * Arc finalises in well under a second, so a trailing window is a lot of
 * blocks and most public RPCs cap `eth_getLogs` well below it. Scans are
 * chunked rather than issued as one enormous range that some providers answer
 * and others silently truncate.
 */
const DEFAULT_MAX_BLOCK_RANGE = 10_000n;

/**
 * viem types `getLogs` results by the event it was handed, which JSDoc cannot
 * carry through the generic `scan` helper below. One cast here beats one at
 * every read site.
 * @param {import('viem').Log} log
 * @returns {Record<string, any>}
 */
const argsOf = (log) => /** @type {any} */ (log).args ?? {};

/**
 * @param {ArcOptions} [options]
 * @returns {RegistryReader}
 */
export function createRegistryReader(options = {}) {
  const rpcUrl = options.rpcUrl ?? process.env.ARC_RPC_URL ?? DEFAULT_ARC_RPC;
  const address = /** @type {`0x${string}`} */ (options.address ?? process.env.VERDIKT_REGISTRY_ADDRESS ?? '');
  if (!address) {
    throw new Error('createRegistryReader: no registry address (pass `address` or set VERDIKT_REGISTRY_ADDRESS)');
  }
  const deployBlock = options.deployBlock ?? BigInt(process.env.VERDIKT_REGISTRY_DEPLOY_BLOCK ?? '0');
  const maxBlockRange = options.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE;
  const client = createPublicClient({ chain: arcTestnet, transport: http(rpcUrl, { batch: true }) });

  /**
   * @param {'ServiceRegistered'|'VerdictWritten'|'RefundCredited'} eventName
   * @param {{ fromBlock?: bigint, toBlock?: bigint, args?: Record<string, unknown> }} [range]
   */
  const scan = async (eventName, range = {}) => {
    const latest = range.toBlock ?? (await client.getBlockNumber());
    const start = range.fromBlock ?? deployBlock;
    const abiEvent = registryAbi.find((item) => item.type === 'event' && item.name === eventName);
    /** @type {import('viem').Log[]} */
    const logs = [];
    for (let from = start; from <= latest; from += maxBlockRange) {
      const to = from + maxBlockRange - 1n > latest ? latest : from + maxBlockRange - 1n;
      const page = await client.getLogs({
        address,
        event: /** @type {never} */ (abiEvent),
        args: /** @type {never} */ (range.args),
        fromBlock: from,
        toBlock: to
      });
      logs.push(...page);
    }
    return logs;
  };

  return {
    client,
    address,

    /** @param {string} serviceId */
    async getService(serviceId) {
      const service = await client.readContract({
        address,
        abi: registryAbi,
        functionName: 'getService',
        args: [/** @type {`0x${string}`} */ (serviceId)]
      });
      return {
        provider: service.provider,
        status: statusFromOrdinal(service.status),
        deposit: service.deposit
      };
    },

    /** @param {string} requestId */
    async getVerdict(requestId) {
      const verdict = await client.readContract({
        address,
        abi: registryAbi,
        functionName: 'getVerdict',
        args: [/** @type {`0x${string}`} */ (requestId)]
      });
      // `writtenAt == 0` is the registry's "no verdict recorded" sentinel.
      if (verdict.writtenAt === 0n) return null;
      return {
        serviceId: verdict.serviceId,
        outcome: outcomeFromOrdinal(verdict.outcome),
        payer: verdict.payer,
        paidAmount: verdict.paidAmount,
        refundCredited: verdict.refundCredited,
        writtenAt: Number(verdict.writtenAt)
      };
    },

    /** @param {string} payer */
    getOwed(payer) {
      return client.readContract({
        address,
        abi: registryAbi,
        functionName: 'getOwed',
        args: [/** @type {`0x${string}`} */ (payer)]
      });
    },

    /**
     * Every service ever registered, with its live state.
     *
     * `ServiceRegistered` is the only place a `serviceId` maps back to its
     * human-readable slug — keccak256 is one-way and the registry does not
     * store the string (Specification.md §3).
     */
    async listServices(range = {}) {
      const logs = await scan('ServiceRegistered', range);
      const registrations = logs.map((log) => {
        const args = argsOf(log);
        return {
          serviceId: /** @type {string} */ (args.serviceId),
          slug: /** @type {string} */ (args.slug),
          provider: /** @type {string} */ (args.provider),
          registeredAtBlock: log.blockNumber
        };
      });
      const states = await Promise.all(registrations.map((entry) => this.getService(entry.serviceId)));
      return registrations.map((entry, index) => ({ ...entry, ...states[index] }));
    },

    /**
     * `VerdictWritten` over a block range, newest last.
     *
     * This is the marketplace's history view. The hourly aggregate workflow
     * reads the same event but through CRE's own EVM capability, not through
     * here — a workflow has no HTTP client pointed at an RPC.
     */
    async listVerdicts(range = {}) {
      const logs = await scan('VerdictWritten', {
        ...range,
        args: range.serviceId ? { serviceId: range.serviceId } : undefined
      });
      return logs.map((log) => {
        const args = argsOf(log);
        return {
          serviceId: /** @type {string} */ (args.serviceId),
          requestId: /** @type {string} */ (args.requestId),
          outcome: outcomeFromOrdinal(Number(args.outcome)),
          payer: /** @type {string} */ (args.payer),
          paidAmount: /** @type {bigint} */ (args.paidAmount),
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash
        };
      });
    },

    /** Refunds actually credited, for the dashboard's "refunds paid over time". */
    async listRefunds(range = {}) {
      const logs = await scan('RefundCredited', range);
      return logs.map((log) => {
        const args = argsOf(log);
        return {
          serviceId: /** @type {string} */ (args.serviceId),
          requestId: /** @type {string} */ (args.requestId),
          payer: /** @type {string} */ (args.payer),
          amount: /** @type {bigint} */ (args.amount),
          blockNumber: log.blockNumber
        };
      });
    }
  };
}
