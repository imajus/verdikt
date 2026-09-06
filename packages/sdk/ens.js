// @verdikt/sdk/ens — the only file in the repo that knows ENS exists.
//
// WHY THIS FILE IS A CHOKE POINT
//
// ENSv2's Permissioned Registry/Resolver are beta. Spike A
// (docs/spikes/A-ens-sepolia.md) confirmed the per-key EAC that justifies
// choosing v2 over v1 does enforce on Sepolia, so the ENSv1 PublicResolver
// fallback is not being taken — but the contracts are explicitly non-final
// before mainnet, so a redeploy or an ABI change is still a live risk, and it
// must not be able to ripple outward.
//
// So: three consumers need ENS data and none of them import an ENS library.
//   - the proxy's passthrough branch needs `address` for the payTo check (§4)
//   - the CRE per-request workflow needs `sla` (§2)
//   - the dashboard needs all four records (§5)
// Each calls `resolveServiceRecord` and gets the same shape back. If v2 has to
// be abandoned, the v1 fallback is written here and Phases 3, 4 and 5 do not
// change.
//
// Two rules that keep the boundary honest:
//   - `sla` comes back as a RAW, UNPARSED string. Parsing belongs to
//     @verdikt/sla, so this file carries no SLA-schema knowledge and a schema
//     change never touches it.
//   - One call returns all four records. A consumer that needs two of them
//     must not make two calls, or batching and caching decisions leak out of
//     this file.
//
// `scripts/ens-sepolia.mjs` imports the record surface below rather than
// keeping a second copy (Tasks.md 4.5). It keeps the registrar, factory and
// EAC-onboarding surface, which the SDK must never carry.

import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  namehash,
  parseAbi,
  toHex
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { packetToBytes } from 'viem/ens';
import { SERVICE_RECORD } from '@verdikt/fixtures';
import { serviceIdOf } from './registry.js';

/** @type {Readonly<Record<string, EnsBackend>>} */
export const ENS_BACKEND = Object.freeze({
  V2: 'ensv2',
  V1: 'ensv1',
  FIXTURE: 'fixture'
});

/**
 * ENSv2 Beta on Sepolia. Confirmed on-chain by Spike A; `pnpm spike:ens
 * --read-only` re-verifies it, because a beta deployment can move.
 */
export const SEPOLIA_UNIVERSAL_RESOLVER = '0x4a1817d13e9cf196f471725176355c1234b63c70';

export const DEFAULT_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

export const DEFAULT_PARENT_NAME = 'verdikt.eth';

/** The text records Verdikt stores on a subname. `address` is not a text record. */
export const TEXT_KEYS = Object.freeze(['url', 'sla', 'conformance', 'availability']);

export const universalResolverAbi = parseAbi([
  'function resolve(bytes name, bytes data) view returns (bytes, address)'
]);

/**
 * The record surface of the PermissionedResolver — reads and writes of the four
 * records, and nothing else. The EAC/onboarding fragments (`initialize`,
 * `authorizeTextRoles`, `authorizeNameRoles`, `hasRootRoles`) deliberately stay
 * in `scripts/ens-sepolia.mjs`: nothing that ships needs them, and carrying them
 * here would make the SDK the registrar it is not.
 */
export const resolverRecordsAbi = parseAbi([
  'function text(bytes32 node, string key) view returns (string)',
  'function setText(bytes32 node, string key, string value)',
  'function addr(bytes32 node) view returns (address)',
  'function setAddr(bytes32 node, address addr_)'
]);

/**
 * DNS wire format — what UniversalResolverV2 and the resolver's authorize* take.
 * @param {string} name
 */
export const dnsEncode = (name) => toHex(packetToBytes(name));

/**
 * `<slug>.<parent>`. The same slug is the Arc serviceId and the
 * `<slug>.verdikt.bond` route, so this is a formatting rule, not a lookup.
 * @param {string} slug
 * @param {string} [parentName]
 */
export const serviceName = (slug, parentName = DEFAULT_PARENT_NAME) => `${slug}.${parentName}`;

/** @type {Map<string, { record: ServiceRecord, expiresAt: number }>} */
const cache = new Map();

/** Drops every cached resolution. Tests and long-lived processes only. */
export function clearServiceRecordCache() {
  cache.clear();
}

/**
 * A chain-level "no" (the name has no resolver, the resolver reverted) as
 * opposed to "we could not reach Sepolia".
 *
 * The distinction is the whole contract of this module: an unresolved record
 * is `null` and the caller takes the status-only fallback deliberately, while
 * an unreachable RPC throws and the caller can retry. Collapsing the two would
 * make a Sepolia outage look like every provider having published no SLA.
 *
 * Deliberately a *positive* test for a revert, not `instanceof
 * ContractFunctionExecutionError`: viem wraps transport failures in that class
 * too, so the negative form silently turned an RPC outage into a marketplace
 * where nobody had published anything. Anything unrecognised propagates, which
 * is the safe direction — the caller retries or falls back rather than
 * recording a fiction.
 *
 * @param {unknown} error
 */
const isChainLevelRefusal = (error) =>
  error instanceof ContractFunctionExecutionError &&
  Boolean(
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError ||
        cause instanceof ContractFunctionZeroDataError ||
        cause instanceof ExecutionRevertedError
    )
  );

/**
 * @param {number|null} value
 * @returns {number|null}
 */
const asScore = (value) => (value !== null && Number.isInteger(value) && value >= 0 && value <= 1000 ? value : null);

/**
 * Parse a `conformance`/`availability` text record.
 *
 * Anything that is not a plain 0–1000 integer resolves to `null` — "not
 * published" — rather than throwing. Only the EAC-scoped CRE signer can write
 * these keys, so a malformed value means something upstream is wrong, and the
 * marketplace showing "no score yet" is a better failure than a dashboard that
 * will not render.
 *
 * @param {string} raw
 * @returns {number|null}
 */
const parseScore = (raw) => (/^\d{1,4}$/.test(raw) ? asScore(Number(raw)) : null);

/**
 * @param {string} rpcUrl
 */
const clientFor = (rpcUrl) =>
  createPublicClient({
    chain: sepolia,
    // Batched so one `resolveServiceRecord` is one round trip rather than four.
    // Batching lives here for the same reason the four reads do: a consumer
    // that made its own calls would have to make this decision again.
    transport: http(rpcUrl, { batch: true })
  });

/**
 * Resolve everything Verdikt stores on a service's `<slug>.verdikt.eth`
 * subname, in one call.
 *
 * Missing records resolve to `null` rather than throwing: a service registers
 * on Arc before it publishes an SLA, and the hourly workflow has not written
 * `conformance`/`availability` for a brand-new listing. Only an unreachable
 * resolver is an error — the caller distinguishes "no SLA published" (`sla:
 * null`, take the status-only fallback) from "could not reach ENS" (throws,
 * also the status-only fallback) by catching.
 *
 * @param {string} slug
 * @param {ResolveOptions} [options]
 * @returns {Promise<ServiceRecord>}
 */
export async function resolveServiceRecord(slug, options = {}) {
  const parentName = options.parentName ?? process.env.ENS_PARENT_NAME ?? DEFAULT_PARENT_NAME;
  const rpcUrl = options.rpcUrl ?? process.env.SEPOLIA_RPC_URL ?? DEFAULT_SEPOLIA_RPC;
  const backend = options.backend ?? ENS_BACKEND.V2;
  const name = serviceName(slug, parentName);
  const serviceId = serviceIdOf(slug);

  const cacheKey = `${backend}|${rpcUrl}|${name}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.record;

  /** @type {ServiceRecord} */
  let record;
  if (backend === ENS_BACKEND.FIXTURE) {
    record = { ...SERVICE_RECORD, slug, name, serviceId, resolvedAt: Date.now() };
  } else if (backend === ENS_BACKEND.V2) {
    record = await resolveThroughUniversalResolver(slug, name, serviceId, rpcUrl);
  } else {
    // Spike A passed, so the v1 PublicResolver fallback was never written. It
    // belongs here if it is ever needed — that is the point of the choke point.
    throw new Error(`resolveServiceRecord: backend "${backend}" is not implemented (Spike A kept ENSv2)`);
  }

  const ttl = options.cacheTtlMs ?? 0;
  if (ttl > 0) cache.set(cacheKey, { record, expiresAt: Date.now() + ttl });
  return record;
}

/**
 * @param {string} slug
 * @param {string} name
 * @param {string} serviceId
 * @param {string} rpcUrl
 * @returns {Promise<ServiceRecord>}
 */
async function resolveThroughUniversalResolver(slug, name, serviceId, rpcUrl) {
  const client = clientFor(rpcUrl);
  const node = namehash(name);
  const dnsName = dnsEncode(name);

  /**
   * @param {`0x${string}`} data resolver calldata
   * @returns {Promise<`0x${string}`|null>}
   */
  const resolve = async (data) => {
    try {
      const [result] = await client.readContract({
        address: SEPOLIA_UNIVERSAL_RESOLVER,
        abi: universalResolverAbi,
        functionName: 'resolve',
        args: [dnsName, data]
      });
      // An unset record comes back as empty ABI data, not a revert.
      return result === '0x' ? null : result;
    } catch (error) {
      // No resolver for the name yet, or the resolver refused: the subname has
      // not been onboarded. That is "no records", not "ENS is down".
      if (isChainLevelRefusal(error)) return null;
      throw error;
    }
  };

  /** @param {string} key */
  const readText = async (key) => {
    const data = await resolve(encodeFunctionData({ abi: resolverRecordsAbi, functionName: 'text', args: [node, key] }));
    if (data === null) return null;
    const value = decodeFunctionResult({ abi: resolverRecordsAbi, functionName: 'text', data });
    return value === '' ? null : value;
  };

  const readAddr = async () => {
    const data = await resolve(encodeFunctionData({ abi: resolverRecordsAbi, functionName: 'addr', args: [node] }));
    if (data === null) return null;
    const value = decodeFunctionResult({ abi: resolverRecordsAbi, functionName: 'addr', data });
    return value === '0x0000000000000000000000000000000000000000' ? null : value;
  };

  const [address, url, sla, conformance, availability] = await Promise.all([
    readAddr(),
    readText('url'),
    readText('sla'),
    readText('conformance'),
    readText('availability')
  ]);

  return {
    slug,
    name,
    serviceId,
    address,
    url,
    sla,
    conformance: conformance === null ? null : parseScore(conformance),
    availability: availability === null ? null : parseScore(availability),
    backend: ENS_BACKEND.V2,
    resolvedAt: Date.now()
  };
}

/**
 * Write the hourly marketplace scores to a service's subname.
 *
 * Lives here rather than in the CRE workflow for the same reason as the read
 * path: writes hit the same beta resolver and the same v2/v1 fallback, so
 * putting them anywhere else would reopen the boundary this file exists to
 * close. The signer must be the address scoped to the `conformance` and
 * `availability` keys — writing `sla` with it reverts with
 * `EACUnauthorizedAccountRoles`, which Spike A asserts against the live
 * Sepolia contracts.
 *
 * NOTE — this is the *EOA* write path, used by the seed and operational
 * scripts. The hourly CRE workflow cannot use it: a CRE workflow holds no key
 * and its only on-chain write is a DON-signed report delivered to an
 * `IReceiver` (Spike B, CRE-2). It writes through `VerdiktScoreWriter` on
 * Sepolia instead, which holds the key-scoped roles and calls `setText` itself.
 *
 * @param {string} slug
 * @param {{ conformance: number, availability: number }} scores 0–1000 integers
 * @param {WriteOptions} options
 * @returns {Promise<{ conformance: string, availability: string }>} transaction hashes
 */
export async function writeServiceScores(slug, scores, options) {
  for (const key of /** @type {const} */ (['conformance', 'availability'])) {
    if (asScore(scores[key]) === null) {
      throw new Error(`writeServiceScores: ${key} must be an integer 0..1000, got ${String(scores[key])}`);
    }
  }
  const parentName = options.parentName ?? process.env.ENS_PARENT_NAME ?? DEFAULT_PARENT_NAME;
  const rpcUrl = options.rpcUrl ?? process.env.SEPOLIA_RPC_URL ?? DEFAULT_SEPOLIA_RPC;
  const name = serviceName(slug, parentName);
  const node = namehash(name);

  const account = privateKeyToAccount(/** @type {`0x${string}`} */ (options.privateKey));
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });

  const resolver = options.resolverAddress ?? (await resolverAddressFor(client, name));
  if (!resolver) throw new Error(`writeServiceScores: no resolver found for ${name}`);

  /** @param {'conformance'|'availability'} key */
  const write = async (key) => {
    const hash = await wallet.writeContract({
      address: /** @type {`0x${string}`} */ (resolver),
      abi: resolverRecordsAbi,
      functionName: 'setText',
      args: [node, key, String(scores[key])]
    });
    await client.waitForTransactionReceipt({ hash });
    return hash;
  };

  // Sequential, not parallel: two writes from one EOA share a nonce.
  return { conformance: await write('conformance'), availability: await write('availability') };
}

/**
 * The resolver UniversalResolverV2 walks to for a name. Returned as the second
 * value of `resolve`, so no consumer has to know a subregistry exists.
 *
 * @param {ReturnType<typeof createPublicClient>} client
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function resolverAddressFor(client, name) {
  try {
    const [, resolver] = await client.readContract({
      address: SEPOLIA_UNIVERSAL_RESOLVER,
      abi: universalResolverAbi,
      functionName: 'resolve',
      args: [dnsEncode(name), encodeFunctionData({ abi: resolverRecordsAbi, functionName: 'addr', args: [namehash(name)] })]
    });
    return resolver;
  } catch (error) {
    if (isChainLevelRefusal(error)) return null;
    throw error;
  }
}
