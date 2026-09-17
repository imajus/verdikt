// Reading the semantic half of a verdict, off GenLayer.
//
// This is the only file in `web/` that knows GenLayer exists, for the same
// reason `packages/sdk/ens.js` is the only file that knows ENS does: one place
// to change when the shape of the read changes, and one place to look when it
// is wrong.
//
// It is here rather than in `@verdikt/sdk` on purpose. The SDK is imported by
// the proxy and by the CRE workflow, and neither has any business reading
// GenLayer — the proxy relays, and the workflow judges the deterministic half.
// Only the dashboard needs both judgements side by side.

import { chains, createClient } from 'genlayer-js';
// Imported here rather than through `@verdikt/sdk/deployments`, which is where
// the Arc and Sepolia records live. The SDK is imported by the proxy and the
// CRE workflow, and neither has any business knowing GenLayer exists — so this
// file stays the only one that does (CLAUDE.md, "Package boundaries").
import deployment from '../../deployments/genlayer-studio-devnet.json' with { type: 'json' };

/** The four outcomes `SlaClaimJudge` can record, plus the one it starts in. */
export const SEMANTIC_OUTCOMES = Object.freeze(['OPEN', 'BREACH', 'MET', 'UNDETERMINED', 'CANCELLED']);

/**
 * Studio Dev — chain id 61997, `https://studio-dev.genlayer.com/api` — is the
 * Agent Tank submission target. It is not one of the four chains this
 * `genlayer-js@1.x` bundles (it lands as `studioDevnet` starting from the
 * `2.0.0-rc.1` line the dashboard does not depend on yet), so it is built the
 * same way GenLayer's own SDK builds it: `studionet` spread with only `id`
 * and `rpcUrls` overridden, since it is the same consensus deployment fronted
 * by a different RPC for pre-release testing.
 */
const STUDIO_DEVNET = Object.freeze({
  ...chains.studionet,
  id: 61_997,
  name: 'GenLayer Studio Devnet',
  rpcUrls: Object.freeze({ default: Object.freeze({ http: Object.freeze(['https://studio-dev.genlayer.com/api']) }) })
});

/** Networks genlayer-js knows by name; a free-form label resolves to nothing. */
const CHAINS = Object.freeze({
  localnet: chains.localnet,
  studionet: chains.studionet,
  testnet_asimov: chains.testnetAsimov,
  testnet_bradbury: chains.testnetBradbury,
  studio_devnet: STUDIO_DEVNET
});

/**
 * A claim as the dashboard shows it. Deliberately *not* merged into
 * `ListingVerdict`: a call can be CRE PASS and semantically BREACH, and
 * flattening the two would destroy the only fact worth showing — that the
 * response was well-formed and wrong (docs/roadmap/genlayer.md).
 *
 * @param {Record<string, unknown>} raw one entry from `list_claims`
 * @returns {SemanticSettlement}
 */
export function toSettlement(raw) {
  const outcome = String(raw.outcome ?? 'OPEN');
  return {
    requestId: String(raw.request_id ?? ''),
    clauseId: String(raw.clause_id ?? ''),
    slug: String(raw.slug ?? ''),
    claimant: String(raw.claimant ?? ''),
    criteria: String(raw.criteria ?? ''),
    // Unknown outcomes are surfaced as-is rather than coerced to a known one:
    // a contract newer than this bundle is a fact the reader should show, not
    // a value to guess at.
    outcome: /** @type {SemanticOutcome} */ (SEMANTIC_OUTCOMES.includes(outcome) ? outcome : 'UNKNOWN'),
    resolved: raw.resolved === true,
    reasoning: String(raw.reasoning ?? ''),
    paidAmount: BigInt(/** @type {string|number} */ (raw.paid_amount ?? 0)),
    compensation: BigInt(/** @type {string|number} */ (raw.compensation ?? 0)),
    bounty: BigInt(/** @type {string|number} */ (raw.bounty ?? 0))
  };
}

/**
 * Index settlements by the request they dispute.
 *
 * A map rather than a lookup per row: one verdict can carry several disputable
 * clauses, so this is one-to-many, and the service page renders every verdict
 * it has.
 *
 * @param {SemanticSettlement[]} settlements
 * @returns {Map<string, SemanticSettlement[]>}
 */
export function byRequest(settlements) {
  /** @type {Map<string, SemanticSettlement[]>} */
  const index = new Map();
  for (const settlement of settlements) {
    const key = settlement.requestId.toLowerCase();
    const existing = index.get(key);
    if (existing) existing.push(settlement);
    else index.set(key, [settlement]);
  }
  return index;
}

/**
 * Whether a settlement is a finding against the provider.
 *
 * Only `BREACH` is. `MET` cleared them, and `UNDETERMINED`/`CANCELLED`
 * deliberately decided nothing at all — counting either as a mark against a
 * provider would make missing evidence worth manufacturing.
 *
 * @param {SemanticSettlement} settlement
 */
export const isBreach = (settlement) => settlement.outcome === 'BREACH';

/**
 * A reader over the deployed `SlaClaimJudge`, or `null` when there is none to
 * read.
 *
 * The address and the network come from `deployments/genlayer-studio-devnet.json`,
 * the same way the Arc registry comes from `deployments/arc-testnet.json`:
 * neither is secret nor environment-varying, so neither belongs in `.env`,
 * where every contributor has to be handed it out of band and nothing can
 * validate it. `judgeAddress` is an override for a fork or a second
 * deployment, not the normal path — mirroring `VERDIKT_REGISTRY_ADDRESS` on
 * the Arc side. What stays per-environment is the RPC, and only that.
 *
 * `null` still has to stay distinguishable from "deployed, no claims": the
 * first means the dashboard cannot say anything about semantic outcomes, the
 * second means there are none.
 *
 * @param {{ judgeAddress?: string, rpcUrl?: string }} options
 * @returns {GenLayerReader | null}
 */
export function createGenLayerReader({ judgeAddress, rpcUrl } = {}) {
  const address = judgeAddress ?? deployment.slaClaimJudge;
  if (!address) return null;
  // The record names its own network; pairing a recorded address with some
  // other chain would read a different contract, or nothing at all.
  const chain = CHAINS[/** @type {keyof typeof CHAINS} */ (deployment.network)];
  if (!chain) return null;

  const client = createClient(rpcUrl ? { chain, endpoint: rpcUrl } : { chain });

  return {
    judgeAddress: address,

    async listSettlements() {
      const claims = await client.readContract({
        address: /** @type {`0x${string}`} */ (address),
        functionName: 'list_claims',
        args: []
      });
      if (!Array.isArray(claims)) return [];
      return claims.map((claim) => toSettlement(/** @type {Record<string, unknown>} */ (claim)));
    }
  };
}
