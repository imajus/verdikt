# Roadmap — pre-flight input validation

**Status: post-hackathon research.** Not scoped for the ETHOnline 2026
submission. This document records why rejecting a malformed request *before* it
is paid for is a natural extension of Verdikt's guarantee rather than a new
product, where the schema would have to come from (checked empirically — the
answer is not where you would expect), and the one boundary decision it shares
with [#21](https://github.com/imajus/verdikt/issues/21) — so the integration is
a deliberate design decision later rather than a rediscovery.

## The gap it closes

Verdikt verifies delivery *after* payment and refunds when the provider misses
its SLA. One case is deliberately excluded: **a 4xx in the status-only fallback
writes no verdict at all** (CLAUDE.md, "Invariants"). The reasoning is sound and
should not change — a 4xx is usually the provider correctly rejecting a
malformed request, and scoring it as failure would let an agent farm refunds
with deliberate garbage.

The consequence is that the agent has no protection against *its own* mistake.
It pays, receives a 4xx, and has no recourse — by design.

This is not hypothetical. On 2026-09-11, while verifying the
`GatewayWalletBatched` fix ([#43](https://github.com/imajus/verdikt/pull/43)), a
call to `portfolio.verdikt.bond` sent:

```json
{"addresses": ["0xe1107cc4594a8685e27b70dfcd333593c5ef0872"]}
```

Alchemy answered `404 Required argument [HttpRequest request] not specified`.
$0.001 USDC settled on Base, nothing was delivered, no verdict was written and
no refund was due. Every layer behaved exactly as specified. The published
schema for that endpoint declares `addresses` as an array of **objects**
(`{address, networks}`), not of strings — a single `type` check against it would
have rejected the request before the payment was ever signed.

## Why this fits Verdikt specifically

- **It closes the hole from the correct side.** The fix is to prevent the
  payment, not to grant a refund. The anti-griefing property of the 4xx
  invariant is untouched — nothing becomes refundable that was not before.
- **The validator already exists.** `packages/sla/jsonschema.js` is a
  hand-rolled, dependency-free JSON Schema subset, written that way because it
  bundles into the CRE workflow. Its `SUPPORTED_KEYWORDS` already cover `type`,
  `properties`, `required`, `enum` and `items` — enough to have caught the case
  above. This is not a new engine, it is a second caller.
- **The SLA already describes a schema, in the other direction.** The `schema`
  clause type in `packages/sla/schema.json` validates the *response* body. A
  request schema is its mirror image: same validator, opposite direction.
- **It makes the pitch two-sided.** Verdikt today protects an agent against
  *provider* failure, after payment. This protects it against *its own* failure,
  before payment.

## Where the schema comes from — the real open question

Checked live against Alchemy's endpoint on 2026-09-11:

**The 402 challenge does not carry an input schema.** The `payment-required`
header decodes to `resource {url, description, mimeType}` plus `accepts[]`, and
nothing else. So Verdikt cannot simply read the schema off the challenge it
already fetches — which was the assumption worth killing early.

The schema *is* published, just elsewhere:

- **Circle's Discovery catalog.** `circle services inspect <url>` returns a full
  `input.body` JSON Schema alongside `method` and `bodyType`.
- **The provider's own OpenAPI.** The same record carries
  `openApiUrl: https://dev-docs.alchemy.com/metadata.json`.

That leaves three sources, and the choice is a real trade-off rather than an
implementation detail:

| Source | Gains | Costs |
| --- | --- | --- |
| An `input` key in the `sla` text record on `<slug>.verdikt.eth` | Self-sovereign, already fetched on every call, versioned with the SLA, mirrors the existing `schema` clause | Only covers providers who deliberately author it — useless for third-party endpoints nobody onboarded |
| A *pointer* in the SLA to the provider's own OpenAPI URL | One source of truth the provider already maintains; broad coverage | A fetch on the hot path (latency + an availability dependency), and the document is mutable and unversioned |
| A third-party catalog (Circle Discovery) | Widest coverage with zero provider effort | Introduces an off-chain trusted third party into a system whose entire premise is not needing one |

The first is the natural place to start; the second is the interesting one to
grow into, with caching. The third is probably incompatible with the project's
trust story, and should be ruled in or out explicitly rather than by default.

Whichever is chosen, the schema is **provider-authored**, so this is advisory.
It can never promise "you will not pay for an error" — only "this request
contradicts what the provider itself published."

## The boundary decision — shared with #21

Rejecting in the proxy means the proxy parses an SLA document and runs a schema
check. CLAUDE.md forbids exactly that: **`proxy` must not depend on
`@verdikt/sla`.**

This is the same undecided question as [#21](https://github.com/imajus/verdikt/issues/21),
which frames it well: *"If it protects evaluation, then reading a published
document is not judging one and the rule can say so. If it protects the
dependency itself, then discovery does not belong on the proxy at all."*

Two features now blocked on one deferred decision is itself an argument for
deciding it.

Request validation is the easier of the two cases, and may be what resolves #21
rather than another thing blocked by it. The boundary exists to protect paid-for
*response* data — content the agent bought, which is why `evaluate` runs inside
the enclave and the observed value never touches a chain. A request body is the
agent's own input: not confidential, not attested, and already in the proxy's
hands. CLAUDE.md already licenses this exact reasoning for a check that runs
outside the enclave — *"a 402 challenge is public, so it needs no attestation."*

If accepted, the minimal shape is to expose the schema subset **without** the
clause engine. `packages/sla/jsonschema.js` is already standalone and knows
nothing about clauses, outcomes or scoring, so the proxy would depend on a
validator rather than on the judgement engine. Whether that honours the rule or
merely routes around it is precisely what #21 has to settle.

## Risks to design against

- **A false rejection is worse than the status quo.** Blocking a call the
  provider would have accepted turns a working paid request into a Verdikt
  outage — strictly worse than the wasted $0.001 this feature exists to prevent.
  Mitigations, in order of safety: ship advisory-first (a warning header, no
  block); reject only on unambiguous violations (`type`, `required`); and offer
  an explicit bypass header for an agent that knows better than the schema.
- **Stale schemas.** A provider that changes its API without updating the SLA
  would have Verdikt rejecting valid requests. Precedent exists for surfacing
  this rather than hiding it: a `failedClause` hash matching nothing already
  means "the provider has edited its SLA since."
- **No `pattern` keyword.** It is deliberately absent from the validator — the
  one keyword whose cost is unbounded in the input, against a document written
  by a party whose bond is at stake. Fine for request validation, but it means a
  request schema can constrain *shape* and not *string format*. Do not claim
  address- or format-level checking.
- **The SLA document's scope grows.** `schema.json` is `{version, clauses}` —
  what a provider promises to *deliver*. An `input` key makes the same document
  also describe what it expects to *receive*. That is a genuine conceptual
  expansion, and worth naming rather than sliding into.

## What has to be decided

1. **#21 first** — whether the proxy may read a published SLA document at all.
   Everything else is downstream of it.
2. **Schema source** — the three options above.
3. **Advisory or blocking by default**, and whether a bypass header exists.
4. **Whether onboarding authors one** — `pnpm onboard` would be the natural
   place to prompt for an input schema when minting `<slug>.verdikt.eth`.

## Sources

- x402 challenge shape — captured live from
  `https://x402.alchemy.com/data/v1/assets/tokens/by-address`, 2026-09-11. The
  402 `payment-required` header carries `resource` and `accepts[]` only; **no**
  input schema.
- Circle Discovery API — `circle services inspect <url>` returns `input.body` as
  a JSON Schema. Spec: https://agents.circle.com/.well-known/openapi.json
- Alchemy OpenAPI metadata — https://dev-docs.alchemy.com/metadata.json
- `packages/sla/jsonschema.js` — the existing subset validator and its
  deliberate omissions
- `packages/sla/schema.json` — the `schema` clause, this feature's mirror image
- Issue #21 — the boundary decision this shares
