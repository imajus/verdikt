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
  same HTTP call is **unresolved**, and Chainlink's own docs contradict each
  other on it. `Specification.md` §2's request path depends on the answer.

## Findings

### CRE-1 — `cre workflow simulate` requires a logged-in CRE account

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

### CRE-3 — whether the trigger response carries the payload back is unresolved

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
- [ ] **`cre workflow simulate` green** — blocked on CRE-1, needs a human to
      `cre login` once
- [ ] **Confidential mode simulates** — same blocker

The last two are the same one-time human step. Everything else has evidence
that reruns from a clean checkout with `bun run test` and `bun run compile`.

## Follow-ups this opens

1. **Settle CRE-3** with one logged-in `--listen` simulate. Highest priority:
   it decides the proxy's shape and it is quick.
2. **Amend `Specification.md` §3 and `IVerdiktRegistry.sol`** for the
   forwarder/`onReport` entry point (CRE-2) before Phase 2 starts on the
   contract.
3. **Amend `Specification.md` §2** once CRE-3 is settled, and add the proxy's
   trigger-signing key (CRE-4) to it and to `.env.example`.
4. **Nothing here blocks Phases 1 or 2's tests.** The evaluation engine and the
   registry's accounting are untouched by all of the above.
