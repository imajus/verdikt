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

A captured run is in [`docs/evidence/cre-simulate-verify.log`](../../docs/evidence/cre-simulate-verify.log).

**`aggregate` needs a deployed registry.** With `registryDeployBlock: "0"` it
scans Arc from genesis and stalls; set it to the registry's real deployment
block before simulating. That is blocked on the Arc deployment (Tasks.md 2.4).
