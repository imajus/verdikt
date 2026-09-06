// The hourly reputation workflow (Specification.md §1, §2; Tasks.md 3.2).
//
// Deliberately a separate workflow from `verify`, and deliberately NOT
// confidential. It reads only public `VerdictWritten` events, makes no Arc
// write and settles no refund. Merging the two would couple the aggregate to
// traffic timing — a zero-call hour would never publish, which is exactly the
// case the 1000-for-no-traffic rule exists to cover — and put non-confidential
// logic inside the TEE.
//
// The arithmetic lives in `@verdikt/cre/reputation` under vitest, because
// `cre workflow simulate` cannot run unattended (Spike B, CRE-1). What is left
// here is capability plumbing.

import {
  CronCapability,
  EVMClient,
  TxStatus,
  bytesToHex,
  cre,
  getNetwork,
  hexToBase64,
  prepareReportRequest,
  type CronPayload,
  type Runtime
} from '@chainlink/cre-sdk';
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  numberToHex,
  parseAbi,
  parseAbiParameters,
  type Hex
} from 'viem';

import { reputationForWindow, WINDOW_SECONDS } from '@verdikt/cre/reputation';
import { outcomeFromOrdinal, statusFromOrdinal } from '@verdikt/sdk/registry';

export type Config = {
  /** Standard cron, six fields. Hourly, per Specification.md §1. */
  schedule: string;
  arcChainSelectorName: string;
  sepoliaChainSelectorName: string;
  /** VerdiktRegistry on Arc — read only; this workflow never writes there. */
  registryAddress: string;
  /** VerdiktScoreWriter on Sepolia — the receiver that holds the EAC roles (§4). */
  scoreWriterAddress: string;
  /** Where log scans start; the registry's deployment block. */
  registryDeployBlock: string;
  /**
   * Arc's nominal block time in seconds. Used only to turn the 7-day window
   * into a `fromBlock`, and to date each log — an EVM log carries no timestamp,
   * and a header read per block would be thousands of calls per run. The
   * approximation is acceptable precisely here: both ratios are display-only,
   * recomputed hourly, and have no refund state behind them (Specification.md
   * §1), so a verdict landing on the wrong side of the boundary costs a
   * slightly stale number for one hour and nothing else.
   */
  blockTimeSeconds: number;
  gasLimit: string;
};

const registryEvents = parseAbi([
  'event ServiceRegistered(bytes32 indexed serviceId, address indexed provider, string slug, uint256 deposit)',
  'event VerdictWritten(bytes32 indexed serviceId, bytes32 indexed requestId, uint8 outcome, address payer, uint256 paidAmount)'
]);

const registryViews = parseAbi([
  'function getService(bytes32 serviceId) view returns ((address provider, uint8 status, uint256 deposit))'
]);

/** Mirrors `VerdiktScoreWriter.onReport`'s decode. The two must change together. */
const SCORE_REPORT_PARAMS = parseAbiParameters('string slug, uint256 conformance, uint256 availability');

/** `values.v1.BigInt` in its JSON form: magnitude as base64 bytes, plus a sign. */
const bigIntJson = (value: bigint) => ({
  absVal: hexToBase64(numberToHex(value < 0n ? -value : value, { size: 32 })),
  sign: value < 0n ? '-1' : '1'
});

const topicOf = (eventName: 'ServiceRegistered' | 'VerdictWritten'): Hex =>
  encodeEventTopics({ abi: registryEvents, eventName })[0] as Hex;

export const onSchedule = (runtime: Runtime<Config>, _trigger: CronPayload): string => {
  const config = runtime.config;

  const arc = getNetwork({ chainFamily: 'evm', chainSelectorName: config.arcChainSelectorName });
  const sepolia = getNetwork({ chainFamily: 'evm', chainSelectorName: config.sepoliaChainSelectorName });
  if (!arc) throw new Error(`unknown chain selector name: ${config.arcChainSelectorName}`);
  if (!sepolia) throw new Error(`unknown chain selector name: ${config.sepoliaChainSelectorName}`);

  const arcClient = new EVMClient(arc.chainSelector.selector);
  const registry = hexToBase64(config.registryAddress);
  const deployBlock = BigInt(config.registryDeployBlock);

  // Anchor the window on chain time, not on the runtime's wall clock: the
  // events being aggregated are dated in block time, and mixing the two would
  // make the window drift with node clock skew.
  const head = arcClient.headerByNumber(runtime, { blockNumber: bigIntJson(-1n) }).result().header;
  if (!head?.blockNumber) throw new Error('could not read Arc head');
  const headNumber = BigInt(bytesToHex(head.blockNumber.absVal));
  const headTimestamp = Number(head.timestamp);

  const windowBlocks = BigInt(Math.ceil(WINDOW_SECONDS / config.blockTimeSeconds));
  const fromBlock = headNumber > windowBlocks + deployBlock ? headNumber - windowBlocks : deployBlock;

  /** An EVM log carries no timestamp; date it from the head and the nominal block time. */
  const timestampOfBlock = (blockNumber: bigint) =>
    headTimestamp - Number(headNumber - blockNumber) * config.blockTimeSeconds;

  // `ServiceRegistered` is scanned from the registry's deployment block, not
  // from the window start: a service registered a year ago is still a listing,
  // and it is the only place a serviceId maps back to its slug — keccak256 is
  // one-way and the registry does not store the string. The score writer needs
  // that slug to derive the subname's node, so this read is not bookkeeping.
  const registrationLogs = arcClient
    .filterLogs(runtime, {
      filterQuery: {
        fromBlock: bigIntJson(deployBlock),
        toBlock: bigIntJson(headNumber),
        addresses: [registry],
        topics: [{ topic: [hexToBase64(topicOf('ServiceRegistered'))] }]
      }
    })
    .result().logs;

  const services = registrationLogs.map((log) => {
    const decoded = decodeEventLog({
      abi: registryEvents,
      eventName: 'ServiceRegistered',
      data: bytesToHex(log.data),
      topics: log.topics.map(bytesToHex) as [Hex, ...Hex[]]
    });
    const serviceId = decoded.args.serviceId;
    // Live status, not the status at registration: a service suspended or
    // deregistered since must be scored accordingly, or dropped.
    const reply = arcClient
      .callContract(runtime, {
        call: {
          to: registry,
          data: hexToBase64(encodeFunctionData({ abi: registryViews, functionName: 'getService', args: [serviceId] }))
        }
      })
      .result();
    const state = decodeFunctionResult({
      abi: registryViews,
      functionName: 'getService',
      data: bytesToHex(reply.data)
    });
    return { serviceId, slug: decoded.args.slug, status: statusFromOrdinal(Number(state.status)) };
  });

  const verdictLogs = arcClient
    .filterLogs(runtime, {
      filterQuery: {
        fromBlock: bigIntJson(fromBlock),
        toBlock: bigIntJson(headNumber),
        addresses: [registry],
        topics: [{ topic: [hexToBase64(topicOf('VerdictWritten'))] }]
      }
    })
    .result().logs;

  const verdicts = verdictLogs.map((log) => {
    const decoded = decodeEventLog({
      abi: registryEvents,
      eventName: 'VerdictWritten',
      data: bytesToHex(log.data),
      topics: log.topics.map(bytesToHex) as [Hex, ...Hex[]]
    });
    return {
      serviceId: decoded.args.serviceId as string,
      outcome: outcomeFromOrdinal(Number(decoded.args.outcome)),
      timestamp: timestampOfBlock(log.blockNumber ? BigInt(bytesToHex(log.blockNumber.absVal)) : headNumber)
    };
  });

  const scores = reputationForWindow({ services, verdicts, now: headTimestamp, windowSeconds: WINDOW_SECONDS });

  // One report per service, each an independent write. A service whose publish
  // fails must not stop the rest: a stale score costs nothing to reconcile,
  // because there is no refund state behind it (Specification.md §1).
  const published: string[] = [];
  for (const score of scores) {
    const report = runtime
      .report(
        prepareReportRequest(
          encodeAbiParameters(SCORE_REPORT_PARAMS, [score.slug, BigInt(score.conformance), BigInt(score.availability)])
        )
      )
      .result();

    const txResult = new EVMClient(sepolia.chainSelector.selector)
      .writeReport(runtime, {
        receiver: config.scoreWriterAddress,
        report,
        gasConfig: { gasLimit: config.gasLimit }
      })
      .result();

    const ok = txResult.txStatus === TxStatus.SUCCESS;
    published.push(`${score.slug}=${score.conformance}/${score.availability}${ok ? '' : ' (write failed)'}`);
  }

  return `window ${WINDOW_SECONDS}s ending ${headTimestamp}: ${published.join(' ') || 'no listed services'}`;
};

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onSchedule)];
};
