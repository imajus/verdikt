# A claimant CLI in JavaScript

`genlayer/scripts/claim.py` is the claimant's CLI: it files a semantic claim and
follows it. It works, and it is the tool `genlayer/README.md` and
`docs/GenLayer.md` document. It is also Python, and an agent that wants to
dispute a call it paid for may not have a Python toolchain — the one this repo
uses needs a virtualenv, a pinned SDK from a git ref, and a 310MB GenVM
artifact cache.

So: a second implementation of the claimant path in JavaScript, for agents.
`claim.py` stays.

## Why not replace `claim.py`

Three things depend on it, and none of them is the agent:

- `genlayer/tests/direct/test_eligibility.py::test_the_disclosure_message_matches_the_proxy_byte_for_byte`
  loads it and asserts `DISCLOSURE_PREFIX` matches `proxy/src/evidence.js`.
- `genlayer/README.md` and `docs/GenLayer.md` document it as the operator's
  how-to.
- It is a known-good reference the port can be checked against, by running both
  against the same claim.

Keeping it costs one duplicated flow. Removing it costs a parity test, two
documented walkthroughs, and the ability to tell a port bug from a chain
problem during a hackathon.

## Where the JavaScript lives

**`scripts/`**, the existing `@verdikt/scripts` workspace package — not a new
JS package under `genlayer/`.

This matters more than it looks. `genlayer/` is deliberately outside the pnpm
workspace: "This is the one Python corner of an otherwise JS repo… nothing here
is part of the pnpm workspace, and `pnpm test` does not run it" (CLAUDE.md).
Putting JavaScript there means a `package.json`, a `node_modules`, a
`pnpm-workspace.yaml` entry, and an amendment to that rule — all to host one
file.

`scripts/` needs none of it:

- already a workspace member, already ESM, already has `viem` and `@verdikt/sdk`
- `vitest.config.js` already includes `scripts/**/*.test.js`, so the parity test
  runs with no config change
- `genlayer/` stays literally Python-only, and the CLAUDE.md rule stays true

It gains one dependency, `genlayer-js@2.0.0-rc.1` — the same pin `runner/` uses,
and the reason is documented there: `genlayer-js@1.x` cannot write to Studio Dev
at all, because consensus v0.6 rejects a write carrying no explicit fee
distribution and 1.x exposes no way to supply one.

`scripts/package.json` currently describes itself as "Spikes and operational
scripts — throwaway by design". That stops being true the moment an agent
depends on one of them, so the description changes with this work.

## Scope: the claimant path only

`sign`, `mint`, `bond`, `open`, `status`, `cancel`.

Left out deliberately:

- **`resolve`** — `runner/bin/resolve-claims.mjs` already does it, on a
  schedule, from a distinct account. Resolving is a bounty hunter's job, not a
  claimant's, and `_settle` releases the bounty out of the claimant's own bond
  on a `MET` outcome, so a claimant resolving its own claim makes that cost
  vanish.
- **`deposit`, `withdraw`** — provider-side. An agent-consumer never calls them.

Flags, subcommand names and printed output match `claim.py`, so the README's
walkthrough reads the same whichever is run.

## Components

### `scripts/claim.mjs`

The CLI. Per subcommand it does what the Python does, including the discipline
that is easy to drop in a port: **every subcommand that moves money reads the
balance back afterwards.** A transaction that mined is not a transaction that
did anything.

### `scripts/genlayer-fees.mjs`

Two things `claim.mjs` and `runner/bin/resolve-claims.mjs` both need:

1. **`settlementAllocations(distribution)`** — the message allocation consensus
   v0.6 requires for the internal message `_settle` sends to the settlement
   token. Without it the validators agree on the judgment and the transaction is
   then rejected as `fee no_matching_allocation # internal`: the money leg
   failing after the judging leg succeeded.

   Two details that fail in unrelated-looking ways when wrong. `callKey` must
   name the method — `release`; `CALL_KEY_UNNAMED` is zeros, looks like a
   wildcard, and matches nothing. And it is one entry per key: `_settle` can
   emit several `release` messages and they all draw on that one allocation's
   budget, so listing it per message is `AllocationDuplicateKey`.

2. **`describeFailure(leaderReceipt)`** — the real error. `genvm_result.stderr`
   is empty for a consensus-level rejection, so reading only that reports every
   such failure as `ERROR: ERROR`. The payload is base64 in `result`.

`cancel` needs both, because `cancel_claim` routes through `_settle`. Extracting
rather than copying is the point: this logic cost a debugging cycle to get
right, and a second copy is a second thing to get wrong silently.

`runner` already depends on a workspace package (`@verdikt/sdk`), so adding
`@verdikt/scripts` follows the existing pattern.

### `scripts/claim.test.js`

Pins `DISCLOSURE_PREFIX`. After this change the exact bytes a payer signs exist
in three places — `proxy/src/evidence.js`, `genlayer/scripts/claim.py`,
`scripts/claim.mjs` — and a drift in any one makes every disclosure refuse,
which reads as a claimant error rather than as the bug it is. Both the Python
and the JavaScript copy are pinned against the proxy's.

## Configuration

Judge and token addresses come from `deployments/genlayer-studio-devnet.json`,
with `--judge`/`--token` and `GENLAYER_JUDGE_ADDRESS`/`GENLAYER_TOKEN_ADDRESS`
as overrides for a fork or a second deployment. Same precedence, and the same
reasoning, as `VERDIKT_REGISTRY_ADDRESS` against `deployments/arc-testnet.json`:
neither address is secret nor varies by environment, so neither belongs in
`.env`, where every contributor has to be handed it out of band and nothing can
validate it.

The claimant's key is `GENLAYER_PRIVATE_KEY`, read from the environment.

## Error handling

Two failure modes this repo has already paid to learn, both of which a naive
port reintroduces:

- **Consensus takes minutes, and the client waits 30 seconds by default.** A
  transaction still at `processing` is not a failed one. Both writes use the
  long interval and retry count.
- **A receipt is not a result.** `waitForTransactionReceipt` returning says the
  transaction is settled, not that the call succeeded: the leader receipt
  carries its own `execution_result`, and an `ERROR` there means the call
  reverted inside the VM while the transaction around it looks healthy. Every
  write checks it, and reports through `describeFailure`.

## Testing

- `scripts/claim.test.js` — the disclosure-prefix pin, and argument parsing for
  anything with a non-obvious default.
- Manual cross-check against the reference: file and follow one claim with
  `claim.py`, one with `claim.mjs`, and compare what lands on chain. This is
  what keeping the Python buys, and it is worth actually doing once.

`pnpm test`, `pnpm lint` and `pnpm typecheck` all pick `scripts/` up already.

## Out of scope

Judge discovery ([#114](https://github.com/imajus/verdikt/issues/114)) — an
agent finding the judge from a paid call rather than being handed an address.
That is a separate piece of work and this CLI does not block it: it reads the
deployment record, the same as everything else here.
