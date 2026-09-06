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

/** @type {Readonly<Record<string, EnsBackend>>} */
export const ENS_BACKEND = Object.freeze({
  V2: 'ensv2',
  V1: 'ensv1',
  FIXTURE: 'fixture'
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
  throw new Error('NOT_IMPLEMENTED: resolveServiceRecord()');
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
 * @param {string} slug
 * @param {{ conformance: number, availability: number }} scores 0–1000 integers
 * @param {WriteOptions} options
 * @returns {Promise<string>} transaction hash
 */
export async function writeServiceScores(slug, scores, options) {
  throw new Error('NOT_IMPLEMENTED: writeServiceScores()');
}
