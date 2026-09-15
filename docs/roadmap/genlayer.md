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
`.emit(on='finalized').release(...)`. GenLayer's internal-message primitive
defers the balance change until the parent transaction finalizes. This is the
documented default and the reason for it applies directly here: an
`on='accepted'` message can be emitted several times across appeals and cannot
be taken back, which for a payout means paying a claimant more than once for a
judgment that was later overturned.

### Escrow, and the missing `unescrow`

Bonds and deposits are posted with `SettlementToken.escrow(custodian, amount)`,
which hands a contract the authority to move part of a balance without moving
the balance. Only the custodian can `release` it, and there is deliberately no
owner-side way to pull an escrow back.

That absence is the mechanism, not an omission. With an `unescrow`, a consumer
could withdraw its bond the moment a claim started going against it and a
provider could withdraw its deposit the moment one was filed — neither would be
a bond. Funds come back out by asking the custodian: `withdraw_deposit`, which
refuses while any claim against the slug is open, and the automatic bond
release when a claim settles.

This is also why GenLayer's async cross-contract writes are not a problem here.
The judge never takes custody of anything; it only ever directs the token at
settlement time, so there is no window in which it holds funds it might fail to
account for.

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
disclosure. Correct in shape. But "fetchable for the resolution round" is where
the two clocks above got conflated.

**Round 4, at implementation — the gate is the payer's signature, not the
existence of a claim.** Round 2's gate asked "has a claim been filed?", which
means the proxy reading GenLayer contract state. GenLayer reads go through
`gen_call` with its own calldata encoding, not ABI; there is no JS path to that
short of shipping `genlayer-js` (1.2MB, viem-dependent) into a Worker, or
hand-rolling the codec. Both are a lot of risk for a question that has a better
answer.

What disclosure actually needs to establish is that the party entitled to the
response consents to it being shown. So the caller presents an EIP-191
signature over `Verdikt evidence disclosure\nrequest: <id>`, and the proxy
checks it recovers to the payer `getVerdict` booked — one Arc read the proxy
already knows how to make.

This is *stronger* than round 2's gate, not weaker. "A claim exists" proves
somebody, possibly anybody, filed against a public request id. "The payer
signed" proves the one party entitled to the response asked for it to be
disclosed. It also lands squarely on the existing invariant: the observed value
never goes on chain and reaches the paying agent on its own response, "which is
the one party entitled to it" — this discloses that agent's own response, to
adjudicators that agent chose.

`submit_claim` therefore takes the signature and stores it, so every validator
re-fetching the evidence presents the same token, and a claim is only openable
by someone holding the payer's consent.

**This also removes the provider opt-in**, and that is a real deviation from
round 2 rather than an oversight. Two reasons. Practically: an opt-in flag
belongs on ENS as a fifth text record, and every already-minted subname would
need its per-key roles re-authorised before a provider could write it — the
feature would be dead on the live testnet. Substantively: the flag was
protecting the wrong thing. The disclosed bytes are a response the payer already
holds; a provider has no standing to forbid the payer from showing its own
purchase to an adjudicator. If an opt-in is still wanted later, it is a fifth
ENS key plus a role migration, and it gates *caching*, not disclosure.

The cost of dropping it is that every verified call with a verdict is cached for
the filing window, whether or not its SLA has a semantic clause. That is
storage the deterministic leg did not previously spend. Bounded by the window,
and noted rather than hidden.

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

**`contentType` comes from the CRE relay, and the first implementation did not
send it.** The workflow built its relay from status and body alone, so
`VerificationResult.headers` was `{}` on every real paid call and every envelope
said `contentType: null` — which the judge correctly refuses as an unsupported
type, resolving *every* semantic claim `UNDETERMINED` against evidence that was
otherwise perfect. Nothing errored; the proxy's own tests supplied the header
that production never did. The relay is now assembled in `cre/lib/relay.js`
under vitest rather than inline in the workflow, for the reason
`cre/lib/http-request.js` already exists: logic that lives only in a file that
bundles to WASM is logic nothing tests. It carries the content type and nothing
else — `content-length` and `content-encoding` count bytes that stop existing
the moment the enclave decodes and clips the body.

**Images are refused until the relay carries bytes.** `bodyEncoding: 'base64'`
is implemented on the judge's side, but the relay decodes every response through
`text(response)` before the proxy ever sees it, so a PNG arrives with its
non-UTF-8 bytes already replaced and the envelope labels it `utf8`. Re-encoding
that and calling it the delivered image puts bytes in front of the model that
the provider never sent, so an image content type that is not `base64` resolves
`UNDETERMINED` rather than being guessed at. Carrying binary losslessly means a
base64 leg through the workflow, the callback and the proxy's own relay to the
agent — its own change, not a line in this one.

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

### The truncation the evidence path inherited — root-caused, and gone

`cre/workflows/verify/workflow.ts` used to truncate the relayed body to 20,000
characters, justified in-comment by "the DON consensus observation is capped
(25kb in simulation)". That justification did not match the code path: the
DON-signed report carries only `serviceId, requestId, outcome, payer,
paidAmount, failedClause` and never the body, and `relay` reaches the proxy
through a direct enclave-to-proxy POST that never crosses `donRuntime`.

**The comment was true when it was written.** At `a9bf43e` the payload came back
as the handler's return value and nothing else; the callback push arrived later
(CRE-9, `17f8b0b`), and the cap was never revisited. A stale justification, not
a wrong one — which is why it read as plausible for weeks.

The limits that do govern the relay are both in `cre/workflows/limits.json`:
`ExecutionResponseLimit` at 100kb for the return value, and
`ConfidentialHTTP.RequestSizeLimit` at 125kb for the callback POST. The smaller
binds, so the budget is 90kb of serialized payload — and it is *measured*
rather than assumed, because a character is not a byte twice over: multibyte
UTF-8, and JSON escaping that can turn one character into six.

`fitToBudget` (`cre/lib/relay-payload.js`) serializes and trims until it fits.
It lives in `cre/lib` rather than in the workflow for the reason the workflow
states about itself — it bundles to WASM and cannot be unit tested, so logic
that lives only there is logic nothing tests, and deciding how much of a paid-for
response gets delivered is exactly that class of code.

Practical effect for evidence: bodies up to ~90kb now survive whole instead of
being clipped at 20k, and anything genuinely larger is still flagged rather than
silently cut. [#88](https://github.com/imajus/verdikt/issues/88).

Until it is, the flag is *told to the judge* rather than acted on in code. Both
alternatives are worse. Refusing every truncated body outright hands any
provider a way to become unjudgeable — pad past the cap and no semantic clause
can be enforced again — which makes missing evidence worth manufacturing, the
same failure `UNDETERMINED` exists to avoid. Judging one unflagged lets a `MET`
rest on the part that went missing. So the prompt carries a contract-authored
notice, outside the evidence fences, saying the body is clipped and that a
binding outcome is available only when the retained part settles the promise on
its own. Both notices — clipped and complete — are asserted by the direct tests,
so dropping either fails rather than passing quietly.

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

### How the read works, and why it looks like this

One **batched** JSON-RPC POST carrying `eth_call` for the verdict and
`eth_getBlockByNumber('latest')` for a clock. Batched because the deadline
compares two timestamps that have to come from the same chain at the same
moment, and because a metered runtime should not pay two round trips to answer
one question. Confirmed working against Arc's RPC.

The calldata and the decode are **hand-rolled**, which is a decision rather than
laziness: GenVM ships no ABI library that reaches an arbitrary chain, and
`getVerdict` returns a single all-static tuple — `bytes32, uint8, address,
uint256, uint256, uint64, bytes32` — so it is seven consecutive words with no
offsets and no tails. Verified against the live registry, which answered exactly
224 bytes for a settled request and for an unset one alike
(`tests/direct/test_arc_live.py`, opt-in).

**The clock is Arc's, not GenLayer's and not a time API.** `writtenAt` is an Arc
block timestamp; measuring it against anything else would be comparing two
clocks. GenVM exposes no block timestamp of its own, and a caller-supplied one
would make the deadline advisory.

`strict_eq` is the right equivalence principle here even though one input moves,
because what is returned is already *derived*: the immutable verdict fields plus
the boolean `within_filing_window`. Validators compare the derivation, never the
timestamp. **A claim filed within seconds of the deadline can still have two
validators derive different booleans** — and that is the correct outcome for a
genuinely contested boundary. They disagree, and consensus rotates, rather than
one node deciding alone.

The rules themselves (`check_eligibility`) are a pure function for the same
reason `settlement_for` is: it is where being wrong costs somebody money, and it
is testable exhaustively without a chain.

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

**The dashboard's SLA composer cannot author one yet.** Its clause editors cover
`schema`, `latency` and `priceRange`, and the fall-through read anything else as
a schema clause — which for a semantic clause means losing the `criteria` and
deleting the provider's promise on the next save. `draftFromText` now throws on
one instead, which routes the composer to its JSON view with the reason and the
record intact. A provider can author a semantic clause there today; a proper
form control is follow-up work nobody owns yet.

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

## Showing it

`web/src/genlayer.js` is the only file in the dashboard that knows GenLayer
exists, for the same reason `packages/sdk/ens.js` is the only one that knows
ENS does. It is in `web/` rather than in the SDK on purpose: the SDK is imported
by the proxy and by the CRE workflow, and neither has any business reading
GenLayer — the proxy relays, the workflow judges the deterministic half. Only
the dashboard needs both judgements at once.

Reads go through `genlayer-js`. GenLayer reads are `gen_call` over its own
calldata encoding rather than ABI, so the alternative was hand-rolling that
codec in JS; in a browser bundle the library is affordable where in a Worker it
was not (see the evidence endpoint's round 4 above, which faced the same
question and answered it differently for good reason). It costs about 29kB
gzipped.

**`null` and `[]` render differently and must keep doing so.** `null` means no
judge is configured or GenLayer could not be read — the dashboard can say
nothing about meaning. `[]` means it read fine and nothing was disputed.
Collapsing them would let an unconfigured dashboard read as a clean record.

And a GenLayer outage never empties the marketplace: Arc's verdicts are the
record, semantic settlements are a second judgement, and a page that refused to
render the first because the second was unreachable would be reporting the
wrong outage.

## The third score

`semanticConformance` = `MET / (MET + BREACH)`, floored, on the same 0–1000
scale as the other two, and **1000 for an empty record** on the same principle:
absence of evidence is not evidence of failure, and a provider nobody has
disputed is not thereby suspect
([#92](https://github.com/imajus/verdikt/issues/92)).

**Only decided disputes count.** `OPEN` has not decided yet;
`UNDETERMINED` and `CANCELLED` decided nothing at all. Folding any of them in
would let a claimant move a provider's public standing by filing claims that
never resolve — the same reasoning that keeps `DOWN` out of the conformance
denominator. A non-answer is not an answer.

**Never averaged into `conformance`.** They measure different questions over
different traffic: every paid call versus only the disputed ones. One merged
figure answers neither, and it would hide exactly the case this whole leg
exists to surface — a spotless deterministic record next to a poor semantic one.

It is written by its own signer, scoped per key with `authorizeTextRoles` and
never `authorizeNameRoles`. That is not bookkeeping: Spike A found the name-wide
grant to be one of the two ways the per-key ACL can be bypassed, and a semantic
aggregator that could also write `conformance` would undo the separation above.
A subname minted before this key existed has nobody authorised for it and reads
back `null` — correct, not a gap; nothing has been published.

**The pipeline is deliberately two programs.** `genlayer/scripts/export-claims.py`
reads the judge and emits JSON; `scripts/publish-semantic-scores.mjs` aggregates
and writes ENS. Split along the toolchain boundary rather than forced into one
language — reading GenLayer means its own calldata codec, writing ENS means viem
and the key-scoped resolver — and the file between them is a feature: for a
number that ranks providers publicly, the exact input it came from is worth
being able to look at. Both halves read back what they wrote.

## Provider deposit cooldown, as built

Withdrawal is two steps: `request_withdrawal` starts the clock,
`withdraw_deposit` releases once it has run out. The deposit stays escrowed and
fully liable throughout — a request records an intention, not a release.

One step is an escape route. Refusing while claims are open only protects
disputes already filed; a provider could still take calls all day, watch for
trouble, and withdraw before anyone got around to filing. The cooldown removes
the timing advantage.

The constructor **refuses a cooldown shorter than twice the filing window**,
because one that does not outlast the exposure is not a shorter cooldown — it is
no cooldown, and it would look configured. The factor of two is the filing
window plus an adjudication runway assumed no longer than it; the proxy owns the
real adjudication clock, and duplicating that number in the contract would only
give it somewhere to drift to.

The clock is Arc's, like the filing deadline — "the cooldown outlasts the filing
window" is only a comparison if both are measured against the same thing. It is
**floored to ten-minute buckets before any validator sees it**: `strict_eq`
compares what the block returns, and two validators reading a raw timestamp a
second apart would disagree on every single call, so the cooldown would never
start. Ten minutes on a multi-day cooldown costs nothing.

### The trap underneath all of this

A nondet block runs in a sub-VM the contract module is not importable from, so a
closure that calls a module-level helper **by name** fails there with
`name '…' is not defined` — while passing every direct-mode test, because direct
mode is in-process. Binding the function to a local alias does not help; it is
still pickled by reference. Values captured as locals do travel.

Found on a real node, not by reading. It would have broken `submit_claim`,
`resolve_claim` and `request_withdrawal` in production with the whole direct
suite green — the same shape as the two silent failures in CLAUDE.md, and worth
the same standing warning. Everything nondet is now inlined; the pure
helpers (`settlement_for`, `check_eligibility`, `withdrawal_refusal`) are safe
because nothing nondet calls them.

### Pre-aging a cooldown against nothing

`deposit_owner` outlives a completed withdrawal — the slug stays pointed at the
outgoing owner until some other account binds it, which `fund_deposit` permits
only once the deposit is back to zero with no claim open — while
`deposit_amount` drops to zero. Until that rebinding happens, the former owner
is still the depositor of record, and without a further check that left two
escape routes: they could call `request_withdrawal` again with no deposit at
risk, aging a cooldown against nothing; and `fund_deposit` never cleared a
stale `withdrawal_requested_at`, so a real deposit landing after that pre-aged
cooldown had already expired could be pulled out immediately, on a clock that
never measured its actual exposure. `request_withdrawal` now refuses on an
unfunded slug, and `fund_deposit` clears any pending request on every call.
Both guards are one-line checks, not arithmetic, and — like the release past
cooldown itself — cannot be exercised by either test suite: reaching
`deposit_owner` set with `deposit_amount` at zero needs a completed
`withdraw_deposit`, which needs a completed `request_withdrawal`, the one call
glsim will not let a write transaction make. See the comment in
`tests/integration/test_escrow_flow.py`.

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
- **Nothing stops a service taking new calls while its withdrawal is
  pending.** The cooldown's safety argument — "by the time the deposit can
  leave, every call it backed has passed its filing deadline" — only holds for
  calls made at or before `request_withdrawal`. `cooldown_seconds >=
  2*filing_window_seconds` covers a call made shortly after the request, but
  not one made near the end of the cooldown itself: its filing deadline can
  still fall after `withdraw_deposit` becomes callable. `submit_claim` does not
  gate on deposit state, so such a call can still be claimed — it just
  settles against a deposit already emptied. Closing this properly means the
  marketplace or proxy delisting a service (or otherwise refusing to route new
  paid calls to it) the moment `request_withdrawal` is called, which this
  contract cannot do itself and which `web/src/genlayer.js` being the only
  file that knows GenLayer exists (CLAUDE.md) currently keeps the proxy from
  doing either. [#93](https://github.com/imajus/verdikt/issues/93).

## Sources

- GenLayer docs — https://docs.genlayer.com (Intelligent Contracts intro,
  Equivalence Principle, non-determinism, web access, image processing,
  validators & roles, tooling setup, deploying)
- GenLayer whitepaper — https://genlayer.com/whitepaper
- Agent Tank hackathon portal — https://portal.genlayer.foundation/agent-tank/
  and `/agent-tank/hackathon`, submission form at `/agent-tank/hackathon/submit`
- `genlayer-project-boilerplate` — https://github.com/genlayerlabs/genlayer-project-boilerplate
- Competitor projects: Uptime (https://uptime-rouge.vercel.app/,
  https://github.com/genlayer-foundation/uptime), Internet Court
  (https://internetcourt.org/, an agent-skill router whose own adjudication
  layer routes to GenLayer Intelligent Contracts), Apolo
  (https://apolo-protocol.xyz/), MergeProof (https://mergeproof.com/),
  Recourse (https://github.com/A-Raphie/recourse), ASSAY
  (https://github.com/Franlinozz/ASSAY)

