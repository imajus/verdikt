# Verdikt CRE workflows

Two workflows, deliberately separate (`Specification.md` §2):

| | `verify/` | `aggregate/` |
|---|---|---|
| trigger | HTTP, from the proxy | Cron, hourly |
| confidential | **yes** — touches the provider's real response | no — reads only public events |
| writes | `VerdiktRegistry` on Arc (verdicts, refunds) | `VerdiktScoreWriter` on Sepolia (ENS scores) |
| refunds | triggers them | never |

Merging them would couple the aggregate to traffic timing — a zero-call hour
would never publish, which is exactly the case the 1000-for-no-traffic rule
exists to cover — and put non-confidential logic inside the TEE.

> **TEMPORARY (demo window).** `WINDOW_SECONDS` in `../lib/reputation.js` is
> **one day**, not the seven `Specification.md` §1 specifies. It shortens both
> the analysis period and the block range fetched, for the hackathon demo
> only. `grep -rn 'TEMPORARY (demo window)'` lists every site to revert.

## Where the logic lives

Both workflow files are capability plumbing. Everything that decides whether a
provider's bond is touched, or what number gets published under their name,
lives in `../lib/` as plain ESM JavaScript under vitest:

- `../lib/judge.js` — SLA vs status-only fallback, and the "write no verdict"
  case (`pnpm vitest run cre`)
- `../lib/reputation.js` — the trailing-window ratios

That split is not tidiness. `cre workflow simulate` needs a one-time
interactive `cre login` (Spike B, CRE-1), so it cannot be a CI check — logic
that lives only in a `.ts` workflow is logic nothing tests on every commit.

## A bun island

`cre-setup` and `cre workflow simulate` are bun-only, so these two packages are
installed with bun and kept out of `pnpm-workspace.yaml`. Workspace packages are
linked with `file:` plus a bun `overrides` entry.

## Files in this directory

| File | What it is |
|---|---|
| `project.yaml` | CRE project settings: the Arc and Sepolia RPCs both workflows resolve. |
| `.env.example` | Optional standalone-CLI environment example. The runner container instead supplies needed values through its own environment. |
| `secrets.yaml` | Verify workflow secret declarations. `CALLBACK_TOKEN` is sourced from `CRE_CALLBACK_TOKEN_VAR` during runner simulation and from the Vault DON when deployed. |

The CLI can read `.env` from the project root, but it also reads normal process
environment variables. The runner container uses the latter: it passes
`CRE_CALLBACK_TOKEN_VAR` (and, only for `--broadcast`, `CRE_ETH_PRIVATE_KEY`)
to the `cre` child, so it does not expect `cre/workflows/.env` to exist.

## Running them

```bash
cd verify      # or aggregate
bun install
bunx tsc --noEmit -p tsconfig.json     # typecheck, including the shared JS packages
bun run compile                        # bundle + WASM, no credentials needed
```

Simulation, from `cre/workflows/` (needs `cre login` once):

```bash
cre workflow simulate verify --listen
curl -X POST http://localhost:2000/trigger -H 'Content-Type: application/json' \
     -d '{"input":{"serviceId":"0x…","requestId":"0x…","providerUrl":"https://…",
                   "paymentHeader":"…","payer":"0x…","paidAmountMinorUnits":"2500","sla":null}}'
```

Captured runs are in [`docs/evidence/`](../../docs/evidence).

`verify` also POSTs its result to the `callbackUrl` in the trigger input, if one
is given. That is how the proxy gets the payload back — there is no documented
way to read an execution's result (docs/spikes/cre.md, CRE-9). To watch it, run
the proxy alongside the simulator and pass its callback URL in the input.

**`aggregate` needs a deployed registry.** With `registryDeployBlock: "0"` it
scans Arc from genesis and stalls; set it to the registry's real deployment
block before simulating. That is blocked on the Arc deployment (Tasks.md 2.4).

**`aggregate` chunks its log scans, and the chunk width is tied to the RPC.**
Arc produces a block roughly every half second, so both of this workflow's
scans outgrow what an `eth_getLogs` provider will answer within days of a
deployment — the deploy-to-head range only grows, and the window range
saturates at `WINDOW_SECONDS / blockTimeSeconds` blocks. The failure is loud
but delayed: `workflow execution failed: [2]Unknown: requested range too
large`, on a run that compiled and triggered fine.

`logChunkBlocks` is the width, measured against the RPC `project.yaml` pins
rather than guessed: `rpc.testnet.arc.network`
answers 30,000 blocks, Arc via Alchemy answers 10,000 on every tier it
publishes. The shipped config uses 30,000 to match the pinned RPC; omit the
field and `cre/lib/config.js` falls back to the portable 10,000. Swapping the
Arc RPC without revisiting this is how it breaks again.

At 30,000 blocks per chunk that is 6 chunks for the TEMPORARY (demo window)
one-day window in `cre/lib/reputation.js`, and 39 for the 7 days the spec
asks for. The `ServiceRegistered` scan is the one that keeps growing — it
is deliberately not windowed, so it costs one chunk per 30,000 blocks since
the registry was deployed, about 5.5 more per day.

**`aggregate` needs `blockTimeSeconds` set.** It is Arc's nominal block time,
used to turn the trailing window into a `fromBlock` and to date each log (EVM
logs carry no timestamp). It is required, not optional: the workflow rejects an
unset, zero, or non-numeric value at startup (`cre/lib/config.js`) rather than
crashing later with a NaN-derived `RangeError`. The estimate is load-bearing —
the same value dates every log, so a wrong one silently shifts the window — so
measure it against live Arc rather than guessing. The shipped `0.5286` is the
average over the 738,531 blocks between the registry's deployment and
2026-09-11, replacing an earlier `0.512` that was off by 3%: harmless at the
scale it was set at, but a 3.5-hour misdating at the far end of a window that
now spans days. Re-measure it the same way if the window ever looks wrong.
