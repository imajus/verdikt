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
scripts/deploy.py              deploys both, then reads them back off chain
tests/direct/                  fast in-memory tests, no node required
tests/integration/             the cross-contract half; needs a node
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
.venv/bin/python -m pytest tests/direct -q                # ~35s cold, ~2s warm, no server
.venv/bin/python -m pytest tests/direct/test_resolve_claim.py -q
VERDIKT_LIVE_ARC=1 .venv/bin/python -m pytest tests/direct/test_arc_live.py -q
```

`test_arc_live.py` is opt-in because it reads the real registry on Arc Testnet
over the public internet. It is what says the mocked verdict bytes everywhere
else are shaped like the real ones — the judge decodes `getVerdict` by hand,
with no ABI library, because GenVM has none that reaches an arbitrary chain.

The integration suite needs a running node. `glsim` is the cheapest one, and it
comes with the testing suite (via the `[sim]` extra, already in
`requirements.txt`):

```bash
.venv/bin/glsim --port 4000 --no-browser &
.venv/bin/gltest tests/integration -q
```

That suite exists for one reason: **direct mode cannot make cross-contract
calls at all**, so the judge↔token wiring — escrow, deposits, release — is
invisible to it. Nothing in there calls an LLM, so no provider key is needed.
Judging a claim does, and that is deliberately left to a real node with real
validators, which is the whole point of the judgment being non-deterministic.

glsim has its own limit, worth knowing before writing a test against it:
**it reverts any write transaction that performs a nondet web call**, at the EVM
consensus layer, before the contract executes. Checked against a local HTTP stub
as well as a real RPC, so it is neither the URL nor network egress. That puts
`submit_claim`, `resolve_claim` and `request_withdrawal` out of reach there —
their rules are covered as pure functions in `tests/direct/` instead.

Run everything from `genlayer/`, not the repo root: `gltest.config.yaml` is
found relative to the working directory, and `direct_deploy` resolves contract
paths against it.

## Deploying

```bash
cp .env.example .env            # then fill in GENLAYER_PRIVATE_KEY
.venv/bin/python scripts/deploy.py --network testnet_bradbury --dry-run
.venv/bin/python scripts/deploy.py --network testnet_bradbury
```

The script deploys the token first (the judge takes its address in the
constructor), then **reads both contracts back off chain** before writing
`deployments/genlayer-bradbury.json`. That read-back is not a flourish: this
repo has already shipped a deployment that mined and did nothing, because the
KeystoneForwarder swallows a receiver revert and reports success. A deployment
is finished when the contract answers, not when the call returns.

**Funding is a manual step and there is no way around it.** The account needs
test GEN, the faucet is at <https://testnet-faucet.genlayer.foundation/>, and it
wants a signed-in wallet holding at least 0.01 ETH on mainnet — 100 GEN per
claim, once a week. `--dry-run` reports the account and its balance without
spending anything, which is the check to run before the real one.

## Filing a claim

`scripts/claim.py` is the claimant's CLI — a CLI rather than a web UI, matching
`scripts/pay-x402.mjs` and `pnpm onboard` on the deterministic side, because the
audience is an operator who already has a key and a request id.

```bash
export GENLAYER_PRIVATE_KEY=0x…      # the claimant; must be the payer Arc booked
export GENLAYER_JUDGE_ADDRESS=0x…
export GENLAYER_TOKEN_ADDRESS=0x…

.venv/bin/python scripts/claim.py sign --request-id 0x…   # payer consent — do not skip
.venv/bin/python scripts/claim.py mint --amount 5000000
.venv/bin/python scripts/claim.py bond
.venv/bin/python scripts/claim.py open --request-id 0x… --clause faithful --slug summarizer \
    --signature 0x…
GENLAYER_RESOLVER_PRIVATE_KEY=0x… \                        # a distinct account — see below
    .venv/bin/python scripts/claim.py resolve --request-id 0x… --clause faithful
.venv/bin/python scripts/claim.py status --request-id 0x… --clause faithful
```

`sign` is the step that is easy to skip and impossible to work around: the proxy
discloses evidence only to the payer, so a claim opened without the payer's
signature resolves `UNDETERMINED` for want of anything to judge. The message it
signs is pinned on both sides — `proxy/src/evidence.test.js` and
`tests/direct/test_eligibility.py` — because a drift there makes every
disclosure refuse, which reads as a claimant error rather than as the bug it is.

`resolve_claim` is permissionless by design — whoever calls it earns the
bounty — and that is precisely what makes a `MET` outcome cost the claimant
anything: the bounty is released out of the claimant's own bond to whoever
resolved. Resolve with the claimant's own key (the default, if
`GENLAYER_RESOLVER_PRIVATE_KEY` is unset) and that release is a debit and a
credit to the same balance, so the "claimant loses the bounty" half of the
demo below silently stops being true. Set `GENLAYER_RESOLVER_PRIVATE_KEY` to a
second, funded account to resolve as an actual third party; `claim.py resolve`
warns when it detects self-resolution.

Every subcommand that moves money reads the balance back. A transaction that
mined is not a transaction that did anything: GenLayer consensus can record an
`ERROR` in the leader receipt while the transaction around it looks fine, so
`claim.py` checks `execution_result` rather than trusting the receipt.

## The demo, and what would make it honest

Four things, and the third is the one usually skipped:

1. **A claim that resolves `BREACH`** — the claimant is compensated from the
   provider's deposit.
2. **A claim that resolves `MET`** — the claimant loses the bounty out of its
   bond. A demo that only shows the claimant winning is advertising, and one
   resolved with the claimant's own key doesn't show it at all: see
   `GENLAYER_RESOLVER_PRIVATE_KEY` above.
3. **Balances read back off chain, before and after.** Not "the transaction did
   not revert". This codebase already learned once that a forwarder can swallow
   a receiver revert and report success; GenLayer's version is an `ERROR`
   execution result inside a perfectly healthy transaction.
4. **`CANCELLED` exercised, not merely present.** The infrastructure-failure
   path — evidence that never becomes fetchable — is the one a real user hits
   first and the one nobody demonstrates.

Settlement is emitted `on='finalized'`, so the money moves when the parent
transaction finalizes rather than when the judgment is recorded. `claim.py
resolve` prints the balance either side of that deliberately: the judgment and
the payment are two events, and showing them as one would misrepresent when a
claimant is actually paid.

## A trap worth knowing: nondet closures cannot call module-level functions

A nondet block (`strict_eq`, `run_nondet_unsafe`) runs in a sub-VM that the
contract module is **not importable from**. A closure that calls a module-level
helper by name fails there with `name '…' is not defined` — while passing every
direct-mode test, because direct mode is in-process and resolves the global
just fine.

So the rule is: inside a nondet closure, inline the work. Values captured as
locals travel (they are pickled by value); functions do not, and binding one to
a local alias does not help — it is still pickled by reference.

This cost a real debugging session and would have broken `submit_claim`,
`resolve_claim` and `request_withdrawal` on any real node while the whole direct
suite stayed green. The pure helpers outside the closures — `settlement_for`,
`check_eligibility`, `withdrawal_refusal` — are safe precisely because nothing
nondet calls them.

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
  decide claims and settle nothing. `tests/integration/` covers that half.

What direct mode does leave is most of the risk: the state machine, every
refusal, the evidence handling, and — as a pure function, factored out for
exactly this reason — the settlement arithmetic.
