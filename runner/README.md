# `@verdikt/runner`

An authenticated bridge between the proxy's `workflows.execute` request and a
long-lived `cre workflow simulate verify --listen` process. It lets the proxy
run the real verify workflow from an always-on Node process.

The runner verifies the proxy's trigger JWT and forwards `params.input` to the
simulator. It never receives or evaluates the verdict: the workflow posts its
result directly to `input.callbackUrl`.

Point the proxy's non-secret `CRE_TRIGGER_URL` at:

```text
https://<runner-host>/workflows/execute
```

## Setup

1. Configure the callback credential. The verify workflow reads its
   TEE-only `CALLBACK_TOKEN` secret from `CRE_CALLBACK_TOKEN_VAR`; it must
   equal the proxy's `CRE_CALLBACK_TOKEN` or callbacks receive 401. Never put
   this value in `config.staging.json`.

2. Authenticate the CRE CLI once on the host that runs the service:

   ```bash
   cd cre/workflows
   cre login
   cre whoami
   ```

   The session must persist at `/root/.cre` inside the runner container.

### Trigger authorization

Two separate checks gate a trigger, and only one of them does anything here:

- **The runner's own JWT check**, against `RUNNER_TRIGGER_ADDRESS` (below) —
  this is what actually authorizes a trigger reaching this service.
- **`authorizedKeys` in `cre/workflows/verify/config.staging.json`** — the
  workflow's own allow-list, enforced only for a workflow *deployed* to real
  CRE infrastructure. `cre workflow simulate` — everything this runner ever
  drives — explicitly does not require it (["Authorization is not required
  during simulation but must be set for
  production"](https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/testing-in-simulation)),
  so leaving it `[]` is correct, not an oversight, for as long as this runner
  is simulation-only. Populate it only once a workflow is actually enrolled
  on real CRE infrastructure (not yet true here — see `CLAUDE.md`).

### Run locally

```bash
pnpm install
cp runner/.env.example runner/.env
# Set RUNNER_TRIGGER_ADDRESS and CRE_CALLBACK_TOKEN_VAR.
node --env-file=runner/.env runner/src/server.js
```

Set `RUNNER_WORKFLOW_DIR` to the absolute path of `cre/workflows` when the
default `/app/cre/workflows` does not apply.

### Run with Docker

```bash
docker build -f runner/Dockerfile -t verdikt-runner .
cp runner/.env.example /secure/path/verdikt-runner.env
# Populate the external file with runner configuration and CRE secrets.
docker run -p 8787:8787 \
  --env-file /secure/path/verdikt-runner.env \
  -v <path-to-your-cre-login-session>:/root/.cre:ro \
  verdikt-runner
```

The runner passes its `CRE_*` environment variables to `cre workflow
simulate`; do not create or mount `cre/workflows/.env` for this container.
Do not commit or bake the external environment file into the image.

## Required environment variables

Provide these through the runner environment or its external Docker
`--env-file`.

| Variable | Required when | Value |
| --- | --- | --- |
| `RUNNER_TRIGGER_ADDRESS` | Always | Public Ethereum address derived from the proxy's `CRE_TRIGGER_PRIVATE_KEY`. |
| `CRE_CALLBACK_TOKEN_VAR` | A trigger includes `callbackUrl` (the normal proxy flow) | Same secret value as proxy `CRE_CALLBACK_TOKEN`; mapped to workflow secret `CALLBACK_TOKEN`. |
| `CRE_ETH_PRIVATE_KEY` | `RUNNER_CRE_BROADCAST=true`, or the hourly score job | Funded burner key for `cre workflow simulate --broadcast`; never use a mainnet or application signing key. **Needs gas on both chains**: `verify` broadcasts to Arc, `aggregate` broadcasts to Sepolia. |
| `ARC_RPC_URL` | The hourly score job | Arc RPC for the post-run read-back. Arc's public default rate-limits `eth_getLogs` well below a full registry scan. |
| `SEPOLIA_RPC_URL` | The hourly score job | Sepolia RPC for the post-run read-back. |

All other settings have defaults. See [`.env.example`](.env.example) for
`RUNNER_PORT`, timeouts, request-size limit, workflow location/target/name,
broadcast, readiness delay, and optional workflow-ID enforcement.

The CRE login session is required but is mounted state at `/root/.cre`, not an
environment variable.

## Hourly score publishing

The `aggregate` workflow publishes the trailing-window `conformance` and
`availability` records to `<slug>.verdikt.eth` (`Specification.md` §1). Until
the workflow is enrolled on real CRE infrastructure its cron never fires on its
own, so the schedule has to come from outside — and this container is the only
place that holds the CRE CLI, the `cre login` session and a broadcast key.

`cre workflow simulate` refuses `--listen` for a cron trigger ("not supported
by cron", per the CLI's own help), so `aggregate` is a fire-once-and-exit run
rather than a second daemon. That is what lets it share this container with the
long-lived `verify --listen` process: the two workflows compile into their own
directories, and only `verify` binds the HTTP trigger port.

[`bin/publish-scores.sh`](bin/publish-scores.sh) is that single run, plus a
read-back of what landed. The read-back is not belt-and-braces: the
KeystoneForwarder swallows a receiver revert and mines anyway, so a successful
`cre` run is not evidence that anything was written (`CLAUDE.md`, "Two silent
failures"). It exits non-zero when a live listing carries no scores, so the job
turns red instead of logging a reassuring wall of text.

### Dokploy job

Dokploy runs a scheduled job as `docker exec <container> <command>` against an
already-running container, so nothing schedules inside the image. Add a
**Schedule Job** on the runner application:

| Field | Value |
| --- | --- |
| Type | Application (this runner's container) |
| Schedule | `0 * * * *` — hourly, matching §1 |
| Command | `/app/runner/bin/publish-scores.sh` |

The container must be running when the job fires, and `docker exec` inherits
the environment the container was created with — so `CRE_ETH_PRIVATE_KEY`,
`ARC_RPC_URL` and `SEPOLIA_RPC_URL` come from the runner's own env file, not
from the job definition.

Run it once by hand before scheduling it. A first run proves three things that
nothing else does: that the `cre login` session inside the container is still
valid (simulate refuses outright when it is not), that the burner key has
Sepolia gas, and that a second `cre` process alongside the `--listen` one
causes no contention.

`RUNNER_CRE_BROADCAST` does not gate this job — that flag belongs to the
`verify` supervisor. `publish-scores.sh` always passes `--broadcast` and
refuses to run without `CRE_ETH_PRIVATE_KEY`, because a run without it reads
Arc, prints a plausible summary and writes nothing.

## Security and operational limits

- `cre workflow simulate` is not a confidential workflow or TEE. The host
  operator can inspect or alter data handled by the simulator.
- The runner buffers request bodies only up to `RUNNER_MAX_REQUEST_BODY_BYTES`
  (1 MiB by default), verifies the trigger JWT, and rejects simulator HTTP
  failures rather than reporting them as accepted.
- A runner instance has one simulator child. Restarting it loses in-flight
  workflow callbacks; run it as a managed service and account for proxy
  timeouts.
- Validate simulator readiness, `/trigger` acknowledgement behavior, and
  broadcast reliability in staging before relying on this service. Broadcast
  transactions are not queued, retried, or rate-limited by the runner.
