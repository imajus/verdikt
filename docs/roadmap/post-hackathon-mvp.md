# Roadmap — the post-hackathon MVP: what stays, what goes

**Status: decided, not yet implemented.** This repo (`imajus/verdikt`) stays
public and untouched as the historical record of the ETHOnline 2026 and
GenLayer Agent Tank submissions. The actual rebuild happens in a **new,
private GitHub org** Denis creates, with a rebrand done at the same time as
the copy. This document records what moves and what doesn't, and why — a
reference for that copy, not a branch plan for this repo.

## Why

Two hackathon submissions accumulated real product surface that exists to
satisfy a specific prize track, not because a real early user needs it.
Post-hackathon, the goal is the smallest product that is easy to pitch:
*a payment proxy for AI agents that automatically refunds you when an API
doesn't deliver what it promised.*

## Cut entirely

### GenLayer / semantic claims

A second chain, a custom settlement token, bonding, an eligibility gate, a
claimant CLI, dual reputation scores — built for GenLayer's Agent Tank prize,
to judge LLM-graded/subjective content. Narrow slice of real x402 traffic:
most APIs (data feeds, structured JSON) are already fully covered by
deterministic `schema`/`latency`/`priceRange` clauses. Nothing about the core
pitch needs it.

### ENS / Sepolia

Already scoped once, for a narrower reason (Arc Microgrants needing a mainnet
deploy) — see the now-superseded `feat/arc-mainnet` branch. Same conclusion,
bigger reason this time: a second chain and its ACL complexity, for a
dependency (SLA/reputation hosting) a single-chain design does more simply,
and that never won a prize either.

### Chainlink CRE

The newest decision, and worth its own reasoning since it's the deepest cut:

- **Confidentiality was never real.** The codebase's own invariant states the
  observed response "reaches [the paying] agent on its own response" — the
  proxy relays it back in the clear regardless. The enclave hides the body
  from node operators, not from anyone who actually matters in this flow.
- **Verifiable execution loses its value once the source is closed.**
  Attestation is only checkable if someone can compare the enclave
  measurement against published source. Closing the source removes the one
  thing that made attestation meaningful — keeping CRE while going
  closed-source would have been an inconsistent position anyway.
- **The cost was real: the whole `cre/` directory** (workflows, CRE CLI,
  simulate/deploy tooling), the `runner/` container standing in for
  Chainlink's gateway, and `ReportReceiver`/`IReceiver`/KeystoneForwarder
  authentication in the contracts.

**The one real, accepted cost.** Verification stops being independently
attested. Today a Chainlink DON judges the call; the rebuild has the proxy
judge it and unilaterally decide whether a provider's bond gets docked — a
trust-model change, not just a complexity cut: from "a neutral judge verifies
this" to "trust the operator's server." **Decided acceptable** for an MVP
pitching real early users — simpler to explain, even ("we check it, we
refund you") — revisit only if early-adopter feedback says otherwise, not
preemptively.

## What stays, and what it becomes

The verification logic itself is unchanged — `packages/sla`'s `evaluate()`
is already pure, dependency-free, no I/O — only where it runs changes:

- **Proxy** runs `evaluate()` locally (no TEE) and submits the verdict
  straight to the registry as a normal signed transaction, instead of a
  DON-signed report through `onReport`. The registry's `ReportReceiver`/
  `IReceiver`/KeystoneForwarder authentication is replaced by a plain
  `recordVerdict(...)` function gated to one pinned `VERIFIER` address the
  proxy holds — same shape as the `SEMANTIC_SCORE_WRITER` pin explored for
  the (now superseded) ENS-removal work, applied to the main verdict path
  instead.
- **Reputation aggregation** becomes a plain cron job reading `VerdictWritten`
  events off Arc and calling a `publishReputation()` write — no CRE workflow,
  no DON report.
- **Registry/escrow** on Arc is otherwise unchanged: bonded deposits, capped
  refunds, pull payments, suspension on a drained deposit.
- **Dashboard** stays, trimmed of anything GenLayer/ENS-specific (semantic
  settlement sections, the dual reputation display, the unused discovery API
  at `/services`, #21).

## Repo and rebrand

- `imajus/verdikt` stays public, as-is, for ETHOnline and GenLayer Agent Tank
  judging history. No further commits here once the copy happens.
- Denis creates a new GitHub org; the essential-minimum slice above gets
  copied there and made private.
- Rebrand (name, domain, positioning) happens at the same time as the copy,
  not before — the name should describe the *stripped-down* product, not the
  hackathon one.

## What's decided vs. open

- [x] Cut GenLayer, ENS, CRE — reasoning above
- [x] Trust-model tradeoff (self-reported verification) — accepted
- [x] Repo strategy — old stays public, new private org, rebrand alongside
- [ ] New org name and rebrand
- [ ] `recordVerdict`/`VERIFIER` pin design and implementation
- [ ] Reputation cron job implementation
- [ ] Actual copy + strip + rename pass
