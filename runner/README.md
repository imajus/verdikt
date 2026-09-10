# `@verdikt/runner`

A stand-in CRE gateway. It bridges the proxy's existing `workflows.execute`
trigger call to a real, long-lived `cre workflow simulate --listen` process,
so per-request SLA verification runs for real (against the actual `verify`
workflow code, doing actual HTTP calls and actual clause evaluation) without
production Confidential Workflow deploy access, which Verdikt does not have
yet (`CLAUDE.md`, `cre whoami` shows "Deploy Access: Not enabled").

It exists because the proxy is a Cloudflare Worker — no `child_process`, no
filesystem, no long-lived process — so it cannot run the `cre` CLI itself.
This service is a small always-on Node process that can.

**This is a stopgap.** Once Verdikt has real Confidential Workflow deploy
access, the intent is to delete this service and repoint the proxy's
`CRE_TRIGGER_URL` at the real CRE gateway instead — no other proxy code
changes either way, see "What changes on the proxy side" below.

## Architecture

```
 agent → proxy (Worker) → RUNNER_TRIGGER_URL ↴
                                                this service, always-on
                                                  ├─ verifies the trigger JWT
                                                  ├─ forwards {input} to
                                                  │  the simulator's
                                                  │  POST :2000/trigger
                                                  └─ answers the proxy with
                                                     {result:{status:"ACCEPTED"}}

         cre workflow simulate verify --listen   (child process, port 2000)
                                                  ├─ runs the real workflow code
                                                  ├─ does the real HTTP call,
                                                  │  real clause evaluation
                                                  └─ POSTs its verdict directly
                                                     to input.callbackUrl —
                                                     i.e. straight back to the
                                                     proxy's own callback route,
                                                     bypassing this service
```

The important thing this diagram is trying to make clear: **this service
never sees a verdict.** It only relays the trigger. The workflow itself
(`cre/workflows/verify/workflow.ts`, ~line 245) owns the return leg — it POSTs
its result directly to `callbackUrl` with its own HTTP capability, the same
way it would in production. That is deliberate: it means this stand-in cannot
accidentally become a place where verdicts are inspected, delayed, or
rewritten in transit.

## What changes on the proxy side

Exactly one config value, no code:

```
CRE_TRIGGER_URL = https://<this-service's-public-host>/workflows/execute
```

(`proxy/wrangler.jsonc`, a non-secret `var` — `wrangler secret put` is not
needed for this one). `CRE_WORKFLOW_ID`, `CRE_CALLBACK_URL`,
`CRE_TRIGGER_PRIVATE_KEY`, `CRE_CALLBACK_TOKEN` are all untouched — the proxy
already treats the trigger URL as swappable, that's the whole reason this
works as a drop-in.

## Setup

### 1. Fill in `authorizedKeys` on the workflow side

`cre/workflows/verify/config.staging.json` currently ships
`"authorizedKeys": []` — an empty placeholder. In production this is how the
DON gateway checks the trigger is actually from Verdikt's proxy. This
runner's own JWT check (`src/jwt.js`) does the equivalent thing for the
simulate path, gated on `RUNNER_TRIGGER_ADDRESS` — but see "Known unknowns"
below on whether `authorizedKeys` is even enforced by `--listen` mode at all.

### 2. Configure the callback token as a CRE secret

The workflow authenticates its POST to `callbackUrl` with a `CALLBACK_TOKEN`
secret (`Authorization: Bearer <token>`). The proxy checks that bearer token
against its own `CRE_CALLBACK_TOKEN` secret
(`proxy/src/router.js`'s `bearerMatches`). **The values must match, or every
verification will be rejected by the proxy callback route with 401.**

For local simulation, put that value in the gitignored
`cre/workflows/.env` as `CRE_CALLBACK_TOKEN_VAR`. For a deployed workflow,
store `CALLBACK_TOKEN` in the Vault DON. It is deliberately absent from
`config.staging.json`, which is committed and contains only non-secret runtime
configuration.

### 3. `cre login`, once, on the host that will run this service

```bash
cd cre/workflows
cre login          # opens a browser; a human finishes the interactive step
cre whoami          # confirms it took
```

This is interactive and cannot be automated or done from inside a Docker
build (see "Credentials" below). It only needs to happen once — the session
persists locally after that, so the `--listen` process this service spawns
does not re-authenticate per call, or even per restart, as long as the
session file survives.

### 4a. Run locally (no Docker)

```bash
pnpm install
cp runner/.env.example runner/.env
# fill in RUNNER_TRIGGER_ADDRESS and CRE_CALLBACK_TOKEN_VAR
node --env-file=runner/.env runner/src/server.js
```

Point `RUNNER_WORKFLOW_DIR` in `.env` at your local `cre/workflows` (an
absolute path, since the process `cwd`s into it to spawn the simulator).

### 4b. Run in Docker

```bash
docker build -f runner/Dockerfile -t verdikt-runner .
cp runner/.env.example /secure/path/verdikt-runner.env
# fill the copied file with the runner settings and CRE secrets
docker run -p 8787:8787 \
  --env-file /secure/path/verdikt-runner.env \
  -v <path-to-your-cre-login-session>:/root/.cre:ro \
  verdikt-runner
```

The `-v` mount is load-bearing — see "Credentials" below for why it can't be
baked into the image, and why this repo cannot tell you the exact host path
(it depends on where `cre login` stores its session on your machine, which
this environment has no way to inspect since `cre` is not installed here).
The runner's process environment is inherited by `cre workflow simulate`, so
do **not** create or mount `cre/workflows/.env` for this container.

## Config reference

See `.env.example` for every variable, with inline explanation. The two that
matter most: `RUNNER_TRIGGER_ADDRESS` (required — the address expected to
have signed the proxy's trigger JWT) and `RUNNER_CRE_BROADCAST` (defaults
`false` — set `true` only once you want this host performing real testnet
writes per verified request).

## Caveats

This section exists because Denis asked for it explicitly — everything below
was surfaced during design, in this environment, without a working `cre` CLI
to verify against. Read it before trusting this service with real traffic.

### This is simulation, not a real TEE

`cre workflow simulate` runs the workflow's logic locally, without a
Confidential Workflow enclave. There is no attestation, no memory isolation,
no hardware guarantee that nobody — including whoever operates this host —
could read or alter the provider's response, the payment header, or the
verdict before it's written. This is the same caveat `docs/Specification.md`
already states about CLI simulation as evidence: it proves the *logic* is
correct, not that the *execution* was confidential. Anyone deciding whether
to trust a verdict produced by this service needs to know it did not run
inside a TEE.

### `--listen` compiles once, not per call

Earlier design discussion (before this service existed) assumed each
verification would need its own `cre workflow simulate` invocation, each
paying the TypeScript→WASM compile cost. That was wrong. `--listen` mode
(`cre/workflows/README.md`) starts one persistent process that compiles once
at startup and then answers every `POST :2000/trigger` from that same
compiled state. This service spawns exactly one `--listen` process per host
(`src/simulator.js`) and restarts it only on crash — not per request.

### Login persists; it is not part of the request path

`cre login` is a one-time interactive step (browser-based password/2FA). Once
done, the CLI's local session is reused non-interactively by every later
`cre` invocation on that machine, including the `--listen` process this
service spawns and its crash-restarts. There is no per-call re-authentication
to worry about — the concern is entirely about *provisioning* that session
onto whatever host runs this service (see "Credentials" below), not about
runtime latency.

### Docker fixes install cost, not the compile step

Pre-baking `pnpm install` / `bun install` into the image (as this
`Dockerfile` does) avoids paying dependency-install time on every container
start. It does **not** avoid the workflow's own TypeScript→WASM compile —
that still happens once, at `--listen` startup, inside the running container,
because the CLI has no documented flag to skip it (`--skip-type-checks` only
skips typechecking, not compilation). A pre-warmed container reduces total
cold-start time; it does not make compilation disappear.

### Known unknowns — this environment has no `cre` CLI to check

Nobody has actually run this service. `cre` is not installed here, so the
following were designed against documentation and code reading, not
observation, and should be verified against a real run before relying on it:

- **Whether `POST /trigger` on the `--listen` server blocks until the
  workflow finishes, or returns as soon as the run is accepted.** `src/
  gateway.js` does not assume either — it races the forward against
  `RUNNER_TRIGGER_ACK_TIMEOUT_MS` and treats a timeout as "still running,
  proceed" rather than a failure, since the workflow's own callback to the
  proxy is what actually resolves anything either way. If `/trigger` in fact
  blocks for the full run, lower the ack timeout so the proxy's own trigger
  round-trip doesn't stack on top of it unnecessarily.
- **The exact text of the `--listen` readiness banner.** `src/simulator.js`
  greps stdout for `/listen|localhost:2000|server started|serving/i` and
  falls back to a fixed `RUNNER_SIMULATOR_WARMUP_MS` delay (default 15s) if
  nothing matches. Watch the container logs on first real run and tighten
  this if the banner text turns out to be something else entirely — the
  fallback will still work, just slower to report ready.
- **Whether `--listen` mode enforces `config.staging.json`'s
  `authorizedKeys` at all**, or only the real DON gateway does. If it is not
  enforced locally, this runner's own JWT check (`src/jwt.js`,
  `RUNNER_TRIGGER_ADDRESS`) is the only access control actually protecting
  `/trigger` from unauthenticated callers.
- **Latency and reliability of `--broadcast`.** With `RUNNER_CRE_BROADCAST=
  true`, each verified request performs a real transaction against a real
  testnet contract. This service does not retry, queue, or rate-limit those
  writes — a burst of concurrent requests could hit RPC rate limits or nonce
  contention with nothing here to smooth it out. Keep it `false` until that's
  been exercised for real.
- **The synthetic `workflow_execution_id`.** There is no real CRE execution
  id available from `simulate` mode over HTTP, so `src/gateway.js` returns
  `sim-<requestId>` instead. The proxy (`proxy/src/verification.js`) never
  reads this field beyond requiring `result.status === "ACCEPTED"`, so this
  is safe today, but it means this ID is not something you can look up
  anywhere.

### This is a single point of failure

One process, one `--listen` child, no horizontal scaling story. If it
restarts, in-flight verifications that were mid-workflow lose their callback
(the workflow process that would have delivered it is gone) and the proxy's
own wait simply times out for those requests — the same outcome as a
real-CRE timeout, just a different cause. This mirrors a caveat the proxy
already states about its own in-memory pending registry
(`proxy/src/verification.js`): a restart loses in-flight calls, and
horizontal scaling would need the callback to reach the same instance. This
runner adds a second instance of the same constraint, not a new kind of one.

### Credentials — do not bake these into the image

- **Never** commit a filled-in `.env`, and never `COPY` one into the
  Dockerfile — the repo-root `.dockerignore` already excludes `.env`/`.env.*`
  at any depth, and this Dockerfile does not override that.
- The `cre login` session is *not* an environment variable and has no
  documented stable path guaranteed across CLI versions — it is local CLI
  state. Do not try to reproduce it by copying files found by guesswork.
  Provision it onto the running host out-of-band (e.g. a mounted volume
  populated by running `cre login` directly on that host, or inside a
  running container via `docker exec`, then keeping the resulting state
  directory mounted) rather than baked into a built image layer.
- If `RUNNER_CRE_BROADCAST=true` is ever used, `CRE_ETH_PRIVATE_KEY` (a
  funded testnet key) is provisioned as a container environment variable (or
  in the external `--env-file` shown above). `CRE_CALLBACK_TOKEN_VAR` is
  provisioned the same way and must equal the proxy's `CRE_CALLBACK_TOKEN`.
  The runner passes both variables to its CRE child; neither belongs in
  `cre/workflows/.env`, the Dockerfile, or any tracked file.
- This service's own JWT verifier (`src/jwt.js`) never sees a private key —
  only a public address (`RUNNER_TRIGGER_ADDRESS`) and signatures to check
  against it.

### `src/jwt.js` is a second implementation, not a shared one

It duplicates `proxy/src/jwt.js`'s encoding rather than importing it — the
proxy is a Workers-only package (`CLAUDE.md`'s package-boundary rule: the
proxy is never a dependency of anything else, and this runner does not
depend on `@verdikt/proxy`). If the proxy's JWT scheme ever changes, this
file needs the same change made independently; `src/jwt.test.js` mints
tokens the same way the proxy does specifically so a divergence fails a test
rather than failing silently in production.
