# Roadmap — single-chain Arc mainnet deployment, ENS dropped

**Status: scoped, not yet implemented.** Branch: `feat/arc-mainnet`, off `main`
(both ETHOnline and GenLayer's Agent Tank submissions are judged; `main` is no
longer frozen). This document is the design; implementation follows it rather
than re-deriving it mid-build.

## Why

Circle/Arc's "Arc Microgrants" program (via DoraHacks, $500 USDC per grant,
hackathon continuations explicitly eligible) requires a live deployment on
**Arc mainnet** — testnet-only builds are explicitly disqualified. `VerdiktRegistry`
currently exists only on Arc Testnet.

Separately: the ENS integration (Sepolia, ENSv2 Permissioned Resolver,
`<slug>.verdikt.eth`) was built for the ETHOnline submission and didn't place.
Keeping a second chain and its ACL complexity alive for a dependency that
hasn't paid for itself is no longer worth the cost it imposes — an extra RPC,
an extra deploy, an extra set of failure modes, for identity/SLA-hosting
plumbing a single-chain design can do more simply. Dropping it isn't just
enabling the mainnet deploy; it's a real simplification on its own terms.

## What changes

### Deleted entirely

- `packages/sdk/ens.js` and its test — the whole ENS abstraction boundary
- Contracts: `VerdiktSubnameRegistrar.sol`, `VerdiktScoreWriter.sol`,
  `EnsNamehash.sol`, `DnsEncode.sol` — all Sepolia/ENS-specific
- Sepolia config, deploy scripts, `PAYMENT_*_RPC_URL` entries for Sepolia,
  ENSv2 Permissioned Resolver setup

### Moves into `VerdiktRegistry`

- **SLA storage**, gated by the `Service.provider` field the struct already
  has: `setSla(serviceId, ...)` restricted to `msg.sender == service.provider`.
  No new ACL machinery — this falls out of a field the contract already
  carries, unlike ENSv2's per-key role bitmap which needed its own careful
  configuration (Spike A found two bypasses in it).
- **`conformance` / `availability` / `semanticConformance` scores**, written
  through the existing `ReportReceiver` pattern — the same DON-forwarder
  authentication `VerdiktRegistry` already uses for verdicts. This is what
  `VerdiktScoreWriter` does today on Sepolia; folding it into the registry
  removes a whole contract and a whole chain dependency, not just a config
  edit.

**SLA storage: full text on-chain.** Decided — simple, and Arc's stable/
predictable gas pricing makes the per-edit cost acceptable for a start. No
off-chain hosting, no "which URL do you trust" question, no separate fetch
path for the CRE workflow or GenLayer's claim judge to get wrong. Revisit only
if a provider's real-world edit frequency makes the gas cost a problem, not
before.

### Downstream

- `cre/workflows/verify/workflow.ts` — SLA read becomes a chain read instead
  of an ENS text-record fetch
- `proxy/src/router.js`, `proxy/src/worker.js` — same
- Dashboard: `web/src/router.js`, `source.js`, `actions.js`, `lit-app.js`,
  `address-view.js`, the SLA wizard form
- `genlayer/contracts/sla_claim_judge.py` — currently hardcodes the Arc
  **Testnet** registry address for its `getVerdict` eligibility read; needs
  repointing at the new mainnet address, plus whatever ABI changes the above
  introduces
- `fixtures/`, and every test touching any of the above (`wizard.test.js`,
  `router.test.js`, `discovery.test.js`, `callback.test.js`,
  `verified.test.js`, and the deleted `ens.test.js`'s coverage needs a new
  home against the registry instead)

## Net effect

Single-chain (Arc only), no Sepolia RPC dependency anywhere. The microgrant's
mainnet requirement is satisfiable with one deploy instead of two. Real cost:
the SLA-storage design decision above, plus touching roughly 15 files across
contracts, CRE, proxy, and dashboard — a multi-day rewrite, not a config
change.

## What's built vs. not

- [x] Scoped: what's deleted, what moves where, what's downstream
- [x] SLA storage design decision — full on-chain text
- [ ] `VerdiktRegistry` changes: `setSla`, score fields, score-writing via
      `ReportReceiver`
- [ ] Old ENS-specific contracts and `packages/sdk/ens.js` removed
- [ ] CRE workflow, proxy, dashboard repointed at the registry for SLA/scores
- [ ] `genlayer/contracts/sla_claim_judge.py` repointed at the new mainnet
      registry address
- [ ] Arc mainnet deployment, funded with real USDC for gas and bonds
- [ ] Arc Microgrants submission (deployed link + public repo + description)
