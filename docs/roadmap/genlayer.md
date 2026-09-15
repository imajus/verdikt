# Roadmap — GenLayer, non-deterministic claim judging

**Status: live design, `feat/genlayer` only.** `main` is frozen for the
ETHOnline submission and nothing here touches it. Tracked as
[#80](https://github.com/imajus/verdikt/issues/80); this document is the design,
the issue is the feature. Where the two disagree, this document is newer.

Built for GenLayer's Agent Tank hackathon (deadline Sep 17 2026, track *Agentic
Commerce Infrastructure*).

## The gap

Verdikt's CRE leg judges a paid call against the provider's own SLA, and
`evaluate` is pure by invariant: no I/O, no clock, no network, no floating
point. That purity is what makes a verdict reproducible inside a DON, and it is
exactly what bounds what a verdict can say. A `schema` clause knows whether the
response parsed; a `latency` clause knows whether it arrived in time; a
`priceRange` clause compares integers. None of them knows whether the *content*
was what was promised.

So a provider can return a syntactically perfect, on-time, correctly-priced
response that is substantively worthless — a summary that summarises a different
document, a translation into the wrong language, an image that does not depict
what was asked for — and Verdikt's deterministic leg scores it PASS, correctly,
because by its own rules it was.

A GenLayer Intelligent Contract closes that. Its Optimistic Democracy consensus
is the one mechanism here that can put a judgment *about meaning* on a chain and
have independent validators agree on it.

## A second, independent judgment

The single most important design decision, and the one everything else follows
from: **the GenLayer judgment is not an appeal of the CRE verdict.** It is a
second, independent judgment of a different question, and the two are displayed
and aggregated separately ([#91](https://github.com/imajus/verdikt/issues/91),
[#92](https://github.com/imajus/verdikt/issues/92)).

| | CRE verdict | GenLayer settlement |
|---|---|---|
| Question | did the response satisfy the deterministic clauses? | did the content satisfy the `semantic` clause's `criteria`? |
| Trigger | every paid call, automatically | a consumer files a claim |
| Chain | Arc | GenLayer |
| Currency | USDC (`msg.value`) | a GenLayer-native settlement token |
| Finality | one confidential run, no dispute layer | Optimistic Democracy, appealable |

A call can legitimately show **CRE PASS alongside a semantic BREACH**. Merging
them into one status would destroy the only fact worth showing — that the
response was well-formed *and* wrong. This is the reason for the separate
`semanticConformance` score rather than folding semantic outcomes into
`conformance`.

The trigger difference is also economic. CRE runs per call because a
deterministic check is cheap. LLM consensus across validators is not, so it runs
on dispute, and the consumer posts a bond to open one.

## Settlement is GenLayer-native

**Revised Sep 15, and this replaced a bridge.** Earlier drafts settled back to
Arc: a GenLayer verdict would be relayed to `VerdiktRegistry`, which would credit
the consumer in USDC from the provider's existing deposit. That was scoped as
[#84](https://github.com/imajus/verdikt/issues/84) (a relay/poller service) and
has been closed, because the requirement it served was never real.

Settling in the same USDC as the original x402 payment *looked* required and was
not. What a claimant actually needs is that a judgment has a consequence the
provider feels. That does not require the consequence to be denominated in the
asset the original call was paid in, and insisting on it bought:

- a cross-chain trust model (who is authorised to make GenLayer's judgment move
  Arc's money?),
- a relay to run and fund,
- finality coupling between two chains with unrelated appeal semantics.

So: a dedicated ERC-20-equivalent token, deployed on GenLayer, with a
permissionless `mint()` standing in for a faucet. Two accounting lines, both in
that token ([#83](https://github.com/imajus/verdikt/issues/83)):

- **Compensation** — sized to numerically match the original `paidAmount` read
  from Arc, clamped to the provider's remaining GenLayer deposit. It is not a
  currency conversion and the token is pegged to nothing; matching the number
  just makes the settlement legible next to the payment that provoked it.
- **Execution-cost bounty** — a fixed constant, not metered against actual gas.
  Whoever calls `submit_claim` / `resolve_claim` pays their own GEN gas directly.
  There is no relay to front or reimburse anything.

GenLayer still **reads** Arc — `VerdiktRegistry.getVerdict()` for eligibility
([#90](https://github.com/imajus/verdikt/issues/90)) — via a plain `eth_call`
over JSON-RPC. A read is not a bridge: nothing on Arc has to trust anything on
GenLayer, which is the whole point.

Payout happens inside `resolve_claim` via the token's
`.emit(on='finalized').transfer(...)`. GenLayer's internal-message primitive
defers the balance change until the parent transaction finalizes. This is the
documented default and the reason for it applies directly here: an
`on='accepted'` message can be emitted several times across appeals and cannot
be taken back, which for a payout means paying a claimant more than once for a
judgment that was later overturned.

## Claim lifecycle

```
                    submit_claim(request_id, clause_id)
                    ├─ eligibility gate (#90)
                    ├─ freeze `criteria` from the SLA (#81)
                    └─ consumer bond escrowed (#83)
                              │
                              ▼
                           OPEN ──────── adjudication window lapses ───► CANCELLED
                              │                                          (bond returned)
                    resolve_claim(request_id, clause_id)
                    ├─ fetch evidence envelope (#82)
                    └─ LLM judgment under Optimistic Democracy
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
           BREACH            MET        UNDETERMINED
```

**Outcomes and bond disposition, all four:**

| Outcome | Consumer bond | Provider deposit |
|---|---|---|
| `BREACH` | returned in full | pays compensation + bounty |
| `MET` | pays the bounty, surplus returned | untouched |
| `UNDETERMINED` | returned in full | untouched |
| `CANCELLED` | returned in full | untouched |

`UNDETERMINED` charges neither side. The claimant absorbs their own gas as the
cost of trying, and that is deliberate: the alternative — forcing a binary
outcome out of incomplete evidence — makes missing evidence adjudicable, and
therefore worth manufacturing. Every path that cannot honestly reach a
conclusion must land here: evidence missing, envelope incomplete, unsupported
content type, provider never opted in.

### Two clocks, not one

An early draft had a single window and it conflated two unrelated things:

- **Filing window** — how long after `verdict.writtenAt` a consumer may open a
  claim. Bounds the provider's exposure.
- **Adjudication window** — how long after a claim is *filed* the evidence stays
  fetchable and the claim stays resolvable. Starts when the claim is filed, not
  when the call was made.

With one clock, a claim filed on the last day of the filing window had no runway
to be adjudicated in. They are separate because they answer different questions.

The adjudication window is also what keeps `cancel_claim` an escape hatch rather
than an exit. Cancelling settles nothing against either side, so a claimant free
to cancel at will holds a free option: file, read the evidence, and withdraw
whenever the judgment looks like going against them. Cancellation is therefore
reachable only once the window has lapsed and `resolve_claim` — which anyone may
call, including the provider — has had its full run at the evidence.

**Where the clock comes from.** `gl.message_raw['datetime']`, the VM's
transaction timestamp: the same instant for the leader and every validator,
which is what makes a deadline judgeable under consensus at all. Two runner
facts constrain this, both verified against the pinned runner rather than the
docs. `gl.message` does not carry `datetime` — only `gl.message_raw` does. And
`gl.vm.get_timestamp()`, the API the current executor documents for this,
landed in a later runner than the one `sla_claim_judge.py` pins, so reaching for
it raises `AttributeError`. Separately, `gltest`'s `direct_vm.warp()` moves the
stdlib clock but *not* `message_raw['datetime']`, so direct-mode tests move both
through the `advance()` helper in `tests/direct/conftest.py`.

## Evidence

`GET /internal/evidence/<request_id>` on the proxy, redesigned three times.
Recording all three because each round fixed a real bug, and the discarded
versions are the argument for the current one.

**Round 1 — cache every response for 24h keyed by `request_id`, invalidate on
first fetch.** Rejected on two counts. `request_id` is public in every
`VerdictWritten` event, so an endpoint keyed on it alone exposes *all* traffic
rather than disputed traffic. And invalidate-on-first-fetch breaks GenLayer's
own consensus, which needs several independent validators to fetch the same
evidence.

**Round 2 — provider opt-in plus dispute gating**, where `submit_claim` unlocks
disclosure. Correct, and still the shape. But "fetchable for the resolution
round" is where the two clocks above got conflated.

**Round 3 — a body is not evidence; an envelope is.** A response body on its own
cannot be judged, because the criteria are about whether the response answered
*this* request. So the endpoint serves:

```json
{
  "requestId": "0x…", "slug": "…",
  "request":  { "method": "POST", "url": "https://…", "body": "…" },
  "response": { "status": 200, "contentType": "application/json",
                "body": "…", "bodyEncoding": "utf8" },
  "cachedAt": 1234567890
}
```

Supported content types: `application/json`, `text/plain`, `text/html` for text
judgment, `image/png` and `image/jpeg` via `exec_prompt(images=[…])`. Anything
else, or an incomplete envelope, resolves `UNDETERMINED` — never a forced
verdict.

`bodyEncoding` is load-bearing rather than decorative, because an image cannot
travel as JSON text: `utf8` (the default when absent) or `base64`, and any
third value is a body this contract cannot read, which is a reason to reach no
conclusion rather than a reason to guess. "Incomplete envelope" is checked
before anything is formatted into a prompt and means what it says — a missing or
wrongly-typed `request` or `response`, or a missing status, method or URL. The
model is never asked for a binding `MET`/`BREACH` over a blank where half the
evidence should have been.

`request.body` is populated from the `bodyHex` the proxy already sends the
workflow. An earlier draft of this section claimed the request body was
unavailable; that was read off a local clone 40+ commits behind `origin/main`,
and `main` had since shipped [#45](https://github.com/imajus/verdikt/pull/45),
"Replay the agent's request body to the provider". Re-verified against current
`origin/main`: `verified()` passes `bodyHex` into `workflow.verify()` and
`VerifyRequest` carries it through.

### The truncation the evidence path inherits

`cre/workflows/verify/workflow.ts` truncates the relayed body to 20,000 chars,
justified in-comment by "the DON consensus observation is capped (25kb in
simulation)". The justification does not match the code path: the DON-signed
report carries only `serviceId, requestId, outcome, payer, paidAmount,
failedClause` and never the body, and `relay` reaches the proxy through a direct
enclave-to-proxy POST that never crosses `donRuntime` at all.

A silently truncated cache could omit exactly the content a semantic clause
turns on, so this has to be root-caused before the evidence cache can claim to
hold the full body. Tracked as
[#88](https://github.com/imajus/verdikt/issues/88).

## Eligibility

Every claim binds to an on-chain fact before any GenLayer execution cost is
spent. `request_id` is public, so without a gate anyone can file against anyone
else's call. Checked via `getVerdict()` on Arc
([#90](https://github.com/imajus/verdikt/issues/90)):

- **Registry address** — fixed in contract config, never caller-supplied.
- **A verdict that exists.** `VerdiktRegistry.getVerdict(requestId)` returns
  Solidity's zero-valued struct for an unset key rather than reverting —
  `outcome: PASS(0), payer: 0x0, writtenAt: 0`. So the check is explicitly
  `writtenAt != 0`, and it is also what rejects the replay-402 and fallback-4xx
  cases: both write no verdict at all, so both fail this test before any
  judgment logic runs.
- **Payer** — `verdict.payer` must be the claimant.
- **Service correlation** — `verdict.serviceId == keccak256(slug)`.
- **Bond posted** — a same-chain check against the settlement token.
- **Filing deadline** — rejected once the filing window has lapsed since
  `verdict.writtenAt`.

The claim key is composite, `(request_id, clause_id)`: one verdict can carry
several disputable semantic clauses.

**Open, not solved: Circle Gateway payers.** Under `GatewayWalletBatched` the
booked payer is the agent wallet's *backing EOA*, and the relationship between
that EOA and the smart account resolves through Circle's wallet API rather than
on-chain data. GenVM has no documented way to hold those credentials safely, so
for now only plain-EOA payers can file. This is the same fact the deterministic
side already lives with (CLAUDE.md, "the payer a verdict books is the account
actually debited") arriving in a new place.

## The `semantic` clause

`packages/sla/schema.json`'s `oneOf` recognised `schema`, `latency` and
`priceRange`, each `additionalProperties: false`. An unrecognised clause type
fails the whole document, and `evaluate()` falls back to `evaluateStatusOnly` on
any validation failure — so naively adding a semantic clause would have silently
**disabled every deterministic clause the provider had declared**, not just
ignored the new one. ([#87](https://github.com/imajus/verdikt/issues/87))

- A fourth `oneOf` branch, `"type": "semantic"`, with a dedicated `criteria`
  field carrying the binding judgment text. Not the existing `description`,
  which stays decorative on every clause type including this one.
- `evaluateClause()` gains `case 'semantic'`, always `pass: true`. CRE
  *recognises* the clause and includes it in the per-call result list; it never
  enforces it. A mixed SLA's deterministic clauses keep producing a real
  PASS/FAIL/DOWN verdict.
- Provider opt-in to evidence caching stays a separate concern. Schema
  validation must remain pure and dependency-free because it bundles into the
  CRE workflow, so it cannot read an ENS flag. A semantic clause without opt-in
  is well-formed but unenforceable — a dashboard warning, not a schema
  constraint.

The `criteria` text is **frozen into contract state at `submit_claim` time** and
deliberately not re-read at `resolve_claim` time. A provider editing its SLA
mid-dispute must not be able to change what is being judged — the same
protection `failedClause` hashing already gives the deterministic side.

## Provider deposit cooldown

A provider's settlement-token deposit must not be withdrawable on demand, or the
escape route is trivial: post it, take calls, withdraw before anyone files.
([#93](https://github.com/imajus/verdikt/issues/93))

1. Withdrawal moves to a pending status with a cooldown safely exceeding filing
   + adjudication.
2. Settlement re-clamps against the deposit's *current* balance at credit time,
   never one read earlier, because liabilities can be concurrent.
3. Insufficient funds clamp to whatever remains rather than reverting. The
   judgment is recorded regardless of whether funds backed it — a provider must
   not be able to erase a finding by being broke.

This is the same escape route originally found in `VerdiktRegistry.deregister()`.
It is still real there and no longer relevant to this path, since nothing here
shares that contract.

## Equivalence principle

The judgment is a classification with a settlement attached, so it needs
comparative validation. A validator that only checks the leader's output parses
as JSON and names an allowed label is not consensus — it proves the leader
formatted its answer correctly and lets the leader decide alone.

`resolve_claim` uses `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)` where
`validator_fn` independently re-fetches the evidence envelope and re-runs the
judgment, then compares the `outcome` field exactly. Reasoning text is free to
differ; the decision is not.

Errors carry the standard prefixes so validators know how to compare them:
`[EXPECTED]` and `[EXTERNAL]` must match exactly, `[TRANSIENT]` agrees if both
sides hit one, `[LLM_ERROR]` always disagrees to force rotation.

### The attack consensus cannot catch

Independent re-judgment defends against a leader that is wrong or dishonest. It
does nothing about a prompt that is poisoned, because every validator rebuilds
the *same* prompt from the same evidence and then agrees with itself —
unanimously, and on the attacker's answer.

Everything interpolated into the judgment prompt was written by a party to the
dispute with money riding on the outcome: the `criteria` and the response body
by the provider, the request body by the claimant. So the prompt fences each
party's text into an explicitly marked block, tells the judge those blocks are
evidence rather than instructions, and restates the standing orders *after* the
evidence so the last word belongs to the contract. `criteria` is quoted as a
description of what was owed, never as a directive addressed to the judge — a
provider is free to promise little, and not to instruct its own adjudicator.

This is a mitigation, not a proof, and it is the reason the judgment prompt is
worth reviewing as carefully as the settlement arithmetic.

## What is unresolved

- **Circle Gateway payers cannot file.** Above.
- **CRE's 20,000-char truncation** is unexplained, and the evidence cache
  inherits it. [#88](https://github.com/imajus/verdikt/issues/88).
- **Who writes `semanticConformance`** — needs an ENS resolver-role decision,
  same per-key EAC pattern the resolver already uses.
  [#92](https://github.com/imajus/verdikt/issues/92).
- **Appeal semantics against a finalized payout.** `on='finalized'` is the
  mitigation, not a proof; a payout that finalizes and is then successfully
  appealed has no modelled recovery.
- **Prompt injection by either party.** Fencing and restated orders are the
  mitigation, not a proof, and consensus does not help here. Above.
- **The adjudication window is a bare constant** in the contract, not yet tied
  to the filing window or to the deposit cooldown that has to outlast both.
  [#83](https://github.com/imajus/verdikt/issues/83),
  [#93](https://github.com/imajus/verdikt/issues/93).
