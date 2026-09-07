# Spike B — Chainlink CRE

Findings for [`Tasks.md`](../Tasks.md) §0.3. Code: [`cre/spike/`](../../cre/spike).

Dated 2026-09-06 against **CRE CLI v1.32.0** and **`@chainlink/cre-sdk`
v1.19.1**. CRE moves fast; re-check anything here that a decision rests on.

## Verdict on the gate

> **Gate — day 3.** No Arc chain selector → verdict writes need a relay path
> (workflow signs, proxy or a keeper submits). Decide before Phase 3.

**Gate passed. No relay path.** Arc Testnet is a first-class CRE write target
and the write goes straight from the workflow. Verdikt does not need a keeper.

**Language: TypeScript**, and not on preference — the shared-engine claim is
now demonstrated rather than assumed (finding CRE-5).

Two things did *not* come back clean, and both are cheaper to absorb now than
in Phase 3:

- **CRE-2** — a CRE workflow cannot call `setVerdict` the way
  `IVerdiktRegistry.sol` declares it. Writes arrive via the KeystoneForwarder
  as `onReport(metadata, report)`. Phase 2's contract shape changes.
- **CRE-3** — whether the proxy gets the workflow's return value back on the
  same HTTP call was **unresolved**, with Chainlink's own docs contradicting
  each other. **Now settled by observation, restrictively:** it does not. The
  proxy triggers and then blocks on the execution result.

## Findings

### CRE-1 — `cre workflow simulate` requires a logged-in CRE account — **RESOLVED**

> **Update, 2026-09-07.** The one-time human step has been taken, and
> `cre workflow simulate` now runs from this checkout. Both workflows in
> `cre/workflows/` execute end to end, and **confidential mode simulates** — the
> run prints the TEE banner ("Trigger requested TEE Execution … AWS Nitro in
> us-west-2") and the handler completes inside it. The two unchecked boxes in
> `Tasks.md` §0.3 are closed.
>
> The finding below stands for anyone starting from a clean machine, and for CI:
> simulation still cannot be an unattended check, because the login is
> interactive.

The spike's headline deliverable ("`cre/spike/` green under `simulate`") cannot
be produced unattended. Every `cre` subcommand that touches a workflow,
`simulate` included, exits before doing any work:

```
✗ Authentication required: not logged in and no CRE_API_KEY set
  → Run 'cre login' interactively, or
  → Set CRE_API_KEY environment variable for non-interactive use
```

Reproduced on CLI v1.32.0, v1.20.0 and v1.10.0, so this is not a recent
regression. `cre login` opens a browser and needs a password (and 2FA), so it
is a human step. `cre init` is gated the same way — the project under
`cre/spike/` is hand-scaffolded from the documented template for that reason.

This does not contradict "simulation needs no beta enrollment". Enrollment
gates *deployment* of Confidential Workflows; an ordinary CRE account still has
to exist. Two separate gates, and only the first one is self-serve.

**Consequence.** Simulation cannot be a CI check. The offline checks in
`cre/spike/README.md` (`bun run test`, `bun run compile`) can, and they were
built to carry as much of the spike's evidence as possible without credentials. A
logged-in `cre workflow simulate` run is still needed to close the spike; the
command is in the README.

### CRE-2 — Arc Testnet is a supported write target, but writes arrive as reports

Arc is supported, and confirmed three independent ways:

| Source | Value |
|---|---|
| [CRE supported networks](https://docs.chain.link/cre/supported-networks-ts) | Arc Testnet — CLI v1.0.7+, TS SDK v1.3.1+ |
| `smartcontractkit/chain-selectors` `selectors.yml` | `5042002 → 3034092155422581607`, name `arc-testnet` |
| `EVMClient.SUPPORTED_CHAIN_SELECTORS['arc-testnet']` in the installed SDK | `3034092155422581607n` |

`https://rpc.testnet.arc.network` answers `eth_chainId` with `0x4cef52`
(5042002), matching the registry entry and `.env.example`'s `ARC_CHAIN_ID`.
Forwarders for Arc Testnet: production
`0x76c9cf548b4179F8901cda1f8623568b58215E62`, simulation (`--broadcast`)
`0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1`.

**But the write is not a normal contract call, and this is the finding.** A
workflow does not hold a key and does not send a transaction. It ABI-encodes a
payload, asks the DON to sign it into a *report*, and hands that to
`evmClient.writeReport(runtime, { receiver, report, gasConfig })`. The
KeystoneForwarder verifies the DON signatures and calls
`receiver.onReport(bytes metadata, bytes report)`.

So `IVerdiktRegistry.setVerdict(bytes32, bytes32, Outcome, address, uint256)`,
callable by a `verifier` address, is not reachable from a workflow. Phase 2
needs:

- `VerdiktRegistry` to implement `IReceiver` — `onReport(metadata, report)`,
  `abi.decode`-ing the same tuple the workflow encodes;
- the immutable role to become the **KeystoneForwarder address**, not a
  verifier EOA;
- `metadata` to be checked as well as `msg.sender`. Its first 109 bytes are a
  header carrying `workflowId`, `workflowName` and `workflowOwner`. The
  forwarder is shared infrastructure — any workflow can reach it — so pinning
  `workflowOwner`/`workflowId` is what actually restricts verdict-writing to
  Verdikt's own workflow. Checking only `msg.sender == forwarder` would let
  any CRE user on Arc write Verdikt verdicts.

None of this disturbs the invariants in `Specification.md` §3. `onReport` still
books `owed[payer]` and sends nothing; the refund cap is unchanged; the payer
and amount still ride in the report. It is the entry point that changes, not
the accounting. The `Outcome` ordinals stay ABI surface — the spike encodes
them through `@verdikt/sdk`'s `OUTCOME_ORDINAL`, which is exactly the mirroring
CLAUDE.md warns about, and `verify.test.ts` asserts PASS = 0 and FAIL = 1 on
the decoded report.

`onReport` returns nothing and the forwarder does not surface reverts usefully,
so a rejected verdict is silent. Phase 2 should emit on every path, including
the ones that decline to write.

### CRE-3 — the trigger response does **not** carry the payload back

> **Update, 2026-09-07 — settled by observation, in the restrictive direction.**
>
> `cre workflow simulate verify --listen`, driven by a real POST to the local
> trigger server:
>
> ```
> $ curl -s -w '%{http_code} in %{time_total}s' -X POST http://localhost:2000/trigger \
>        -H 'Content-Type: application/json' -d '{"input":{…}}'
> 200 in 0.000344s          # empty body
> ```
>
> and roughly a second later, in the simulator's own output:
>
> ```
> ✓ Workflow Simulation Result:
> "{\"outcome\":\"PASS\",\"mode\":\"status-only\",…}"
> ```
>
> The handler's return value exists and is well-formed, but it reaches the
> *simulator*, not the HTTP caller. The trigger POST is acknowledged
> immediately with no body — the fire-and-forget shape from "Triggering deployed
> workflows", not the "sent back as the HTTP response" shape from
> "Configuration & handler".
>
> **Caveat on how far this generalises.** This is the simulator's local trigger
> server, which the CLI presents as a debugging harness, not the production
> gateway. It is the strongest evidence available without a deployed workflow,
> and it agrees with one of the two contradicting doc pages, so **Verdikt is
> built on the restrictive reading**: the proxy must not assume it gets the
> payload back on the same request. Re-check against a deployed workflow if
> production enrollment ever opens.
>
> **Consequence for Phase 4.** Option 2 below is taken — the proxy triggers and
> then blocks on the execution result — because option 1 moves the reading of
> the provider's response out of the enclave and weakens the argument §2 is
> built on. See `proxy/src/verification.js`.

The original finding, for the record:

**This is the one that can invalidate a design, and the docs disagree with
themselves.**

[Triggering deployed workflows](https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/triggering-deployed-workflows)
shows the gateway answering immediately:

```json
{ "jsonrpc": "2.0", "id": "req-123", "method": "workflows.execute",
  "result": { "workflow_id": "0x…", "workflow_execution_id": "0x…", "status": "ACCEPTED" } }
```

and then directs you to the CRE UI or `cre execution status|logs` to see what
the run produced — the shape of a fire-and-forget submission.

[Configuration & handler](https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/configuration-ts)
says the opposite, in as many words: *"The value returned from your callback
will be sent back as the HTTP response."*

`Specification.md` §2 needs the second reading. The agent's request blocks on
the proxy, and the proxy has nothing to relay back unless the workflow's return
value comes with the response. If the first reading is the true one, the
request path has to change, and the options are:

1. **Proxy calls the provider; enclave re-reads it.** The proxy makes the paid
   call and relays the body, and triggers the workflow to verify. Keeps the
   agent's latency low, but the enclave is no longer the only thing that reads
   the response — and the provider-facing argument in §2 is that the code
   reading its data is attested. Weakens the pitch it is built on.
2. **Proxy blocks on the execution result.** Trigger, then poll execution
   status until the run finishes. Preserves the trust story exactly; adds the
   whole workflow round trip to every paid call's latency, and needs a timeout
   policy for a run that never lands.

Do not pick between these from the docs. **Settle it with one logged-in
`cre workflow simulate --listen` run** against `cre/spike/verify`: send a
signed trigger request and look at whether the HTTP response body carries the
handler's return value or an `ACCEPTED` envelope. That is a ten-minute check
and it decides the proxy's architecture.

### CRE-4 — the HTTP trigger is signature-gated, which the proxy must satisfy

`authorizedKeys` is not a bearer token or an allowlist of addresses. It is a
list of `{ type: "KEY_TYPE_ECDSA_EVM", publicKey: "0x…" }` pairs, and the
gateway validates a JWT signed by the corresponding private key, with `exp` at
most five minutes out and `jti` for replay protection.

Two consequences for Verdikt:

- **The proxy needs a signing key** — its own, distinct from the verifier
  identity, used only to authorize trigger calls. That is a key
  `Specification.md` §2 does not currently mention ("Verdikt holds no wallet on
  the payment leg" stays true; this is not the payment leg).
- **It is the access control on verdict-writing.** An unauthorized caller
  cannot trigger the workflow, so it cannot manufacture a verdict — worth
  stating explicitly next to the `setVerdict` role rules, since the on-chain
  role alone no longer tells the whole story after CRE-2.

Also: **one HTTP trigger per workflow**, no routing between handlers. Fine for
Verdikt — the per-request workflow has exactly one entry point, and the hourly
aggregate is a separate cron workflow anyway.

### CRE-5 — TypeScript, and the shared engine is demonstrated

`Tasks.md` §0.3 leaves the language open with a "strong preference for TS". The
preference is now backed by evidence.

`cre/spike/verify` imports `@verdikt/sla` and `@verdikt/sdk/registry` — plain
ESM JavaScript, typed by JSDoc against ambient `.d.ts` files, exactly as
CLAUDE.md's conventions require — and both survive the whole pipeline:

- the CRE typechecker resolves them and their ambient types;
- `cre-compile` bundles their bodies into the WASM binary. Verified by grepping
  the intermediate bundle for `outcomeToOrdinal`'s error string and the `FAIL`
  ordinal, both of which are present.

The seam then proved itself by accident. Rebasing this branch onto `main` after
`FAIL_CONFORMANCE`/`FAIL_UNREACHABLE` were renamed to `FAIL`/`DOWN` merged
cleanly as text and immediately failed `bun run compile`: `SlaOutcome` no longer
admitted the old strings. A Go port would have rebased just as cleanly and kept
compiling, with the two enums silently disagreeing — and disagreeing about
outcome *names* is how a FAIL gets recorded as a PASS.

So the Go alternative's cost is real, avoidable, and now observed rather than
argued: `evaluate()` would exist twice, and for a final undisputable verdict two
copies that can drift are a correctness risk, not duplication. **Choose TS.** No
reason found to revisit `cre/package.json`'s existing bet.

Two frictions came with it, neither disqualifying:

- **bun, not pnpm.** `cre-setup` (which fetches Javy) and `cre workflow
  simulate` are bun-only. `cre/spike/verify` is installed with bun and kept out
  of `pnpm-workspace.yaml` so the rest of the workspace is untouched. Phase 3
  has to decide whether `cre/` proper joins the pnpm workspace or stays a bun
  island; the island is simpler and was chosen here.
- **`workspace:*` does not resolve under bun** outside a bun workspace, so
  `@verdikt/sdk`'s own `workspace:*` dependency on `@verdikt/fixtures` breaks
  the install. Worked around with a `file:` link plus a bun `overrides` entry.
  Phase 3 should fix this properly rather than copy the workaround.
- **Ambient globals need explicit inclusion.** `SlaOutcome` and friends live in
  `packages/sla/types.d.ts` with no `export`, and an import does not carry
  ambient globals across a package boundary. The spike's `tsconfig.json` names
  the file directly and sets `maxNodeModuleJsDepth: 2`; without the latter both
  imports silently degrade to `any`, which would have made the whole exercise
  prove nothing.

### CRE-6 — the SDK's test harness has no TEE runtime factory

`@chainlink/cre-sdk/test` exports `newTestRuntime` (a DON `Runtime`) plus
capability mocks — `EvmMock`, `HttpActionsMock`, `ConfidentialHttpMock` — which
is enough to unit-test an ordinary handler with no CLI and no network.
`TestTeeRuntime` exists in the package but is not reachable through that entry
point, and there is no `newTestTEERuntime`.

`verify.test.ts` works around it with a `Proxy` that adds `usingTheDons()` and
`reportFromDon()` to a `TestRuntime`. Capability dispatch is then identical on
both sides of the shim, which is exactly what the mocks would see — but it
proves nothing about the enclave boundary itself. Read those tests as "the
right values cross the DON boundary", never as "the enclave holds".

## What the spike does and does not cover

Checked off from `Tasks.md` §0.3:

- [x] **Arc chain selector exists** — `arc-testnet`, `3034092155422581607`
- [x] **Workflow language decided** — TypeScript, on the evidence in CRE-5
- [x] **Outbound HTTP from inside the workflow** — in the handler, compiled and
      unit-tested against `HttpActionsMock`
- [x] **EVM write** — `writeReport` to the Arc selector, asserted on the
      decoded report tuple
- [x] **HTTP trigger** — wired and typechecked, with the authorization model
      understood (CRE-4)
- [x] **`cre workflow simulate` green** — both workflows run; the login has
      been done once (CRE-1)
- [x] **Confidential mode simulates** — the `verify` run prints the TEE banner
      and completes the handler inside it

Everything except the two above reruns from a clean checkout with
`bun run compile`; simulation needs the one-time interactive login, so it still
cannot be a CI check.

## Follow-ups this opens

1. ~~**Settle CRE-3**~~ — done, see the update above. The proxy blocks on the
   execution result.
2. ~~**Amend `Specification.md` §3 and `IVerdiktRegistry.sol`**~~ — done. The
   registry implements `IReceiver` through `ReportReceiver`.
3. ~~**Amend `Specification.md` §2**~~ — done, along with the proxy's
   trigger-signing key (CRE-4) in `.env.example`.
4. **Nothing here blocks Phases 1 or 2's tests.** The evaluation engine and the
   registry's accounting are untouched by all of the above.

### CRE-9 — the gateway's trigger contract, and how the paid leg gets its result back

> **Resolved.** Option 2 below was taken and then demonstrated end to end:
> `docs/evidence/cre-callback-roundtrip.log` is a real
> `cre workflow simulate verify --listen` run, in confidential mode, where the
> enclave POSTs its finished verification to the proxy's callback route and the
> proxy's waiting request picks it up by `requestId`. The provider's response
> body arrives intact, which is the thing the paid leg exists to relay.

CRE-3 settled *that* the trigger response does not carry the handler's return
value. `proxy/src/verification.js` was then written to trigger and poll, before
the gateway's actual contract had been read. Reading it
([triggering deployed workflows](https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/triggering-deployed-workflows))
confirms one third of that design and breaks the rest.

**Right.** The gateway is real and speaks JSON-RPC:

| | |
|---|---|
| public (onchain) registry | `https://01.gateway.zone-a.cre.chain.link` |
| private registry | `https://01.enterprise-gateway.zone-a.cre.chain.link/` |
| method | `workflows.execute` |
| params | `params.input` (your payload), `params.workflow.workflowID` (64 chars) |

The client currently posts `{ input }` at the top level. Wrong shape; cheap fix.

**Wrong — the auth token cannot be a token.** The header is
`Authorization: Bearer <JWT>`, but the JWT is minted per request: an ECDSA
signature over `base64url(header).base64url(payload)`, and the payload carries
`digest`, the SHA256 of *that exact JSON-RPC body*. A credential that depends on
the request body cannot be a fixed string in an env file.
The setting has to become the proxy's private key, with the client signing a
fresh short-lived JWT per call — now `CRE_TRIGGER_PRIVATE_KEY`, implemented in
`proxy/src/jwt.js` and checked by recovering the signature back to the issuer.
The exact shape: header `{"alg":"ETH","typ":"JWT"}`; payload `digest` (SHA256 of
the body, `0x`-prefixed), `iss` (the signing address), `iat`, `exp` (at most 5
minutes after `iat`), `jti` (UUID v4); signature an EIP-191 `personal_sign` over
`base64url(header).base64url(payload)`, base64url-encoded as `r ‖ s ‖ v`. This is consistent with CRE-4, which
said "the proxy needs a signing key" — the config simply did not follow it.

**Open, and it is the load-bearing one.** *There is no documented HTTP endpoint
for reading an execution's result.* Chainlink documents `workflow_execution_id`
in the trigger response, the CRE UI, and `cre execution status <uuid>` on the
CLI. None of those is something a proxy can call per request.

That mattered more than the other two, because the paid leg's whole shape rests
on it: the enclave holds the only copy of what the agent bought (an x402 payment
settles once), and polling an execution was the assumed way to get it back. The
options were:

1. **Find the undocumented API the CRE UI itself calls.** Most likely to exist;
   depends on an interface Chainlink has not committed to.
2. **Have the workflow push the result out** — a confidential HTTP call from
   inside the enclave to a proxy callback, correlated by `requestId`. Keeps the
   payload out of CRE's execution store, and the proxy is already holding the
   agent's connection open. Adds an inbound endpoint the proxy must authenticate.
3. **Fall back to CRE-3's option 1** — the proxy makes the paid call and the
   enclave verifies afterwards. Rejected before because it moves the reading of
   the provider's response out of the enclave, and is unavailable anyway: the
   payment settles once.

**Option 2 was taken**, and needed nothing undocumented. The workflow POSTs to a
`callbackUrl` passed in the trigger input; the proxy serves
`/internal/verification-callback` and correlates by `requestId`. Two things
authenticate it — a shared bearer the workflow holds, and the `requestId` being
32 random bytes the proxy issued and has not yet answered. Forging a callback
could not fake the on-chain verdict, which the DON signs, but it would hand a
paying agent the wrong bytes, which is why the route refuses everything when no
token is configured.

Consequences worth stating:

- **The proxy is stateful for the life of a request.** In-memory only, since an
  entry is meaningless once the connection it refers to is gone — but a restart
  loses in-flight calls, and more than one proxy instance needs the callback to
  reach the same one.
- **The push is best-effort.** A failed callback does not throw inside the
  workflow: the verdict is already on Arc by then, and throwing would lose the
  response body the agent paid for to report a delivery problem the proxy
  notices anyway when it times out.
- **The callback token belongs in `secrets.yaml`**, released by the Vault DON,
  not in workflow config where it currently sits. It authenticates bytes that
  reach a paying agent.

### CRE-8 — the report header offsets, confirmed against the SDK

`Tasks.md` §2.1 carried these as documentation-derived and unverified, on the
grounds that a wrong `workflowOwner` offset rejects every verdict silently. They
are now cross-checked field by field against
`@chainlink/cre-sdk/dist/sdk/report.js`, which parses the same header on the way
back out:

| field | offset | size |
|---|---|---|
| version | 0 | 1 |
| executionId | 1 | 32 |
| timestamp | 33 | 4 |
| donId | 37 | 4 |
| donConfigVersion | 41 | 4 |
| workflowId | 45 | 32 |
| workflowName | 77 | 10 |
| workflowOwner | 87 | 20 |
| reportId | 107 | 2 |
| body | 109 | — |

`contracts/src/IReceiver.sol` matches all of it. Two things this settles beyond
the offsets:

- **`workflowName` is raw UTF-8, not a hash** — the SDK decodes it with
  `TextDecoder('utf-8')`. `bytes10(bytes("verdikt-verify"))` therefore truncates
  to exactly the ten bytes the forwarder carries, so pinning the full workflow
  name works and needs no hand-truncation. A name *shorter* than 10 bytes
  depends on the forwarder's padding, which is untested — ours are 14 and 17
  bytes, so the question does not arise.
- **`workflowOwner` is an address**, `encodeHexLower` of 20 bytes.

Not yet observed against a live delivery — that needs a deployed workflow — so
the residual risk is a header *version* change, not a wrong offset.

### CRE-7 — an EVM log carries no timestamp

`FilterLogsReply.logs[]` has `blockNumber` but no `blockTimestamp`, and there is
no batch header read. A literal trailing-7-day window would need one
`headerByNumber` per block, which is thousands of calls an hour.

The aggregate reads the head once and dates each log from
`headTimestamp - (headNumber - logBlock) * blockTimeSeconds`. The approximation
is acceptable *here specifically*: both ratios are display-only, recomputed
hourly, and have no refund state behind them (`Specification.md` §1), so a
verdict landing on the wrong side of the boundary costs a slightly stale number
for one hour. It would not be acceptable anywhere a refund depended on it.
