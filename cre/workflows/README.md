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
| `.env.example` | The CRE CLI's own env file — copy to `.env`. Only `CRE_ETH_PRIVATE_KEY`, and only `link-key`, `deploy` and `simulate --broadcast` need it. |
| `secrets.yaml` | Empty and unreferenced today. Where provider request credentials go when the enclave needs them (Specification.md §2). |

The CLI reads `.env` from the project root — this directory, the one holding
`project.yaml` — not from the repo root. The repo-root `.env` is for everything
else; nothing in the CLI reads it.

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

**`aggregate` needs `blockTimeSeconds` set.** It is Arc's nominal block time,
used to turn the 7-day window into a `fromBlock` and to date each log (EVM logs
carry no timestamp). It is required, not optional: the workflow rejects an
unset, zero, or non-numeric value at startup (`cre/lib/config.js`) rather than
crashing later with a NaN-derived `RangeError`. The estimate is load-bearing —
the same value dates every log, so a wrong one silently shifts the window — so
measure it against live Arc rather than guessing (`0.512` for the current Arc
testnet). The `config.staging.json` in this repo already carries it.
