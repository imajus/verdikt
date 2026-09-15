# genlayer

The semantic half of a Verdikt verdict: a GenLayer Intelligent Contract that
judges whether a paid API response actually satisfied what the provider
promised, on dispute, under Optimistic Democracy consensus.

`docs/roadmap/genlayer.md` is the design and takes precedence over inference
from this code. The short version: Verdikt's CRE leg judges the deterministic
clauses of an SLA and is pure by invariant — no I/O, no clock, no network. That
purity is what makes a verdict reproducible inside a DON and exactly what stops
it judging *content*. `SlaClaimJudge` judges the part purity excludes, and the
two verdicts are kept separate everywhere: a call can legitimately be CRE PASS
and semantic BREACH.

This is the one Python corner of an otherwise JS repo, because GenVM runs
Python. It is a separate toolchain on purpose — nothing here is part of the
pnpm workspace, and `pnpm test` does not run it.

## Layout

```
contracts/sla_claim_judge.py   the Intelligent Contract that judges a claim
contracts/settlement_token.py  what a claim settles in — a faucet-minted token, escrow included
tests/direct/                  fast in-memory tests, no node required
gltest.config.yaml             network table; `testnet_bradbury` is GenLayer's public testnet
```

### Escrow, and why there is no `unescrow`

`SettlementToken.escrow(custodian, amount)` hands a contract the authority to
move part of your balance; the tokens do not go anywhere and still count as
yours. Only the custodian can `release` them.

There is deliberately no owner-side way to pull an escrow back. If there were,
a consumer could withdraw its bond the moment a claim started going against it
and a provider could withdraw its deposit the moment one was filed — which is
to say neither would be a bond at all. Getting funds back out means asking the
custodian, which is what `SlaClaimJudge.withdraw_deposit` and the automatic
bond release on a settled claim are for.

## Setup

```bash
cd genlayer
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/genvm-lint setup        # ~310MB of GenVM artifacts, cached in ~/.cache
```

## Commands

```bash
.venv/bin/genvm-lint check contracts/sla_claim_judge.py   # lint + semantic validation
.venv/bin/python -m pytest tests/direct -q                # ~35s, no server
.venv/bin/python -m pytest tests/direct/test_resolve_claim.py -q
```

Run everything from `genlayer/`, not the repo root: `gltest.config.yaml` is
found relative to the working directory, and `direct_deploy` resolves contract
paths against it.

## The runner pin

The first line of the contract pins the GenVM Python runner by hash:

```python
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

This is not decoration. Every GenLayer network rejects `py-genlayer:test`,
`py-genlayer:latest` and unversioned aliases — they are local-development
aliases for runtime developers, and a contract carrying one deploys nowhere.
The linter will mention that a newer runner exists; upgrading is a deliberate
change, because the runner's API is not stable across versions (`gl.Contract`
and `allow_storage` move between them).

## What direct mode does and does not prove

Two hard limits, both worth knowing before trusting a green run:

- Direct tests run the **leader function only**. `validator_fn` — the half that
  decides whether validators agree — is never exercised, so nothing here says
  anything about consensus.
- **Cross-contract calls do not work at all.** `gl_call`'s
  `CallContract`/`PostMessage` operations are unhandled in direct mode unless
  glsim's hook is installed, so a judge wired to a token is untestable here.
  The fixtures deploy the judge with an empty `token_address`, which makes it
  decide claims and settle nothing.

What that leaves is still most of the risk: the state machine, every refusal,
the evidence handling, and — as a pure function, factored out for exactly this
reason — the settlement arithmetic. The wiring between the two contracts needs
a real node (#85).
