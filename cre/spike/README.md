# Spike B — Chainlink CRE

Answers `docs/Tasks.md` §0.3. Findings and the gate decision live in
[`docs/spikes/cre.md`](../../docs/spikes/cre.md); this file is how to run it.

`verify/` is a cut-down version of the per-request confidential workflow
(`Specification.md` §2): HTTP trigger → in-enclave call to the provider →
deterministic evaluation → ABI-encoded verdict written to Arc Testnet. It is
not the real workflow — no ENS read, no `X-PAYMENT` decode, no SLA parsing —
because those wait on Spikes A and C and on Phase 1.

## Prerequisites

The CRE TypeScript toolchain is **bun-only** (`cre-setup` fetches the Javy WASM
compiler, and `cre workflow simulate` shells out to bun). This directory is
therefore installed with bun and deliberately left out of
`pnpm-workspace.yaml`; the rest of the repo is unaffected.

```bash
curl -sSfL https://cre.chain.link/install.sh | bash   # cre CLI (v1.32.0 used here)
curl -fsSL https://bun.sh/install | bash              # bun >= 1.2.21
```

## Run it

```bash
cd cre/spike/verify
bun install
bun run setup           # one-time: downloads Javy into ~/.cache/javy
```

(Use `bun run setup`, not `bunx cre-setup` — `bunx` does not resolve that bin
out of `@chainlink/cre-sdk-javy-plugin`.)

Two of the three checks need no CRE account:

```bash
bun run test            # 6 tests, capability mocks, no network
bun run compile         # typecheck + bundle + WASM
```

The third does. `cre workflow simulate` refuses to run without credentials
(finding CRE-1), so log in first — the browser step is interactive and cannot
be automated:

```bash
cre login
cd cre/spike
cre workflow simulate ./verify \
  --target staging-settings \
  --non-interactive \
  --trigger-index 0 \
  --http-payload ./verify/fixtures/trigger-request.json
```

Add `--broadcast` to submit the verdict write through Arc Testnet's
MockKeystoneForwarder for real. That needs `CRE_ETH_PRIVATE_KEY` in `.env`
(see `.env.example`), a funded Arc Testnet account, and `registryAddress` in
`verify/config.staging.json` pointed at a real receiver — it's still the
placeholder `0x0…1`, so leave `--broadcast` off here.

This spike is superseded by the real workflow at `cre/workflows/verify`,
which already points at the deployed `VerdiktRegistry` (see root `CLAUDE.md`).
Use this directory only to re-run the original spike check.

## What each check actually proves

| Check | Proves | Needs an account |
|---|---|---|
| `bun run test` | the handler writes the right verdict tuple to the `arc-testnet` selector, and the provider's response body does not cross back out of the enclave | no |
| `bun run compile` | `@verdikt/sla` and `@verdikt/sdk` — plain ESM JS with ambient `.d.ts` — typecheck and bundle into the WASM binary | no |
| `cre workflow simulate` | the trigger, the enclave boundary and the EVM capability behave end to end | **yes** |

The first two are the ones worth keeping past the spike. They are the seed of
the Phase 3 workflow's test suite, and they run in CI without credentials.

They are not a substitute for the third: nothing here exercises a real enclave,
and `verify.test.ts` fakes the `TeeRuntime` (finding CRE-6). What it can show
is that the values crossing the DON boundary are the right ones.
