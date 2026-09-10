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

1. Set `authorizedKeys` in `cre/workflows/verify/config.staging.json` to the
   proxy signing public key. This is the workflow trigger allow-list; the
   runner also verifies the trigger JWT using `RUNNER_TRIGGER_ADDRESS`.

2. Configure the callback credential. The verify workflow reads its
   TEE-only `CALLBACK_TOKEN` secret from `CRE_CALLBACK_TOKEN_VAR`; it must
   equal the proxy's `CRE_CALLBACK_TOKEN` or callbacks receive 401. Never put
   this value in `config.staging.json`.

3. Authenticate the CRE CLI once on the host that runs the service:

   ```bash
   cd cre/workflows
   cre login
   cre whoami
   ```

   The session must persist at `/root/.cre` inside the runner container.

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
| `CRE_ETH_PRIVATE_KEY` | `RUNNER_CRE_BROADCAST=true` | Funded Arc Testnet burner key for `cre workflow simulate --broadcast`; never use a mainnet or application signing key. |

All other settings have defaults. See [`.env.example`](.env.example) for
`RUNNER_PORT`, timeouts, request-size limit, workflow location/target/name,
broadcast, readiness delay, and optional workflow-ID enforcement.

The CRE login session is required but is mounted state at `/root/.cre`, not an
environment variable.

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
