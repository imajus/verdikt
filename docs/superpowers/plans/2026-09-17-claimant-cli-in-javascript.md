# Claimant CLI in JavaScript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A JavaScript claimant CLI (`scripts/claim.mjs`) that files and follows a semantic claim on GenLayer, for agents with no Python toolchain.

**Architecture:** One CLI file in the existing `@verdikt/scripts` workspace package, plus one shared module holding the GenLayer fee-allocation and receipt-error logic that `runner/bin/resolve-claims.mjs` also needs. `genlayer/scripts/claim.py` stays as-is and remains the documented operator tool.

**Tech Stack:** Node ESM, `genlayer-js@2.0.0-rc.1`, vitest.

## Global Constraints

- `genlayer-js` must be pinned to exactly `2.0.0-rc.1` — the same pin `runner/package.json` uses. `1.x` cannot write to Studio Dev at all: consensus v0.6 rejects a write carrying no explicit fee distribution and `1.x` exposes no way to supply one.
- `genlayer/` gains no `package.json`, no `node_modules`, and no `pnpm-workspace.yaml` entry. It stays Python-only, as CLAUDE.md states.
- Judge and token addresses come from `deployments/genlayer-studio-devnet.json`. `--judge`/`--token` and `GENLAYER_JUDGE_ADDRESS`/`GENLAYER_TOKEN_ADDRESS` are overrides for a fork or a second deployment, never the normal path.
- The claimant's key is `GENLAYER_PRIVATE_KEY`, read from the environment.
- Every write waits with `interval: 5000, retries: 95`. Consensus on studio_devnet takes minutes and the client's 30-second default reports a pending transaction as a failure.
- Every write checks `execution_result` on the leader receipt. A returned receipt means the transaction settled, not that the call succeeded.
- The exact disclosure bytes are `Verdikt evidence disclosure\nrequest: <lowercased id>` and must match `proxy/src/evidence.js` and `genlayer/scripts/claim.py` byte for byte.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/genlayer-fees.mjs` | Create — settlement message allocation + leader-receipt error decoding. Shared by `claim.mjs` and `runner/bin/resolve-claims.mjs`. |
| `scripts/genlayer-fees.test.js` | Create — pins the allocation shape and the error decoder. |
| `scripts/claim.mjs` | Create — the CLI: `sign`, `mint`, `bond`, `open`, `status`, `cancel`. |
| `scripts/claim.test.js` | Create — pins `DISCLOSURE_PREFIX` against the proxy's bytes. |
| `scripts/package.json` | Modify — add `genlayer-js`, fix the "throwaway by design" description. |
| `runner/package.json` | Modify — add `@verdikt/scripts` workspace dependency. |
| `runner/bin/resolve-claims.mjs` | Modify — import the two helpers instead of defining them. |
| `genlayer/README.md` | Modify — note the JS alternative in the claim walkthrough. |

---

### Task 1: The shared fee module

**Files:**
- Create: `scripts/genlayer-fees.mjs`
- Create: `scripts/genlayer-fees.test.js`
- Modify: `scripts/package.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `MESSAGE_BUDGET: bigint`
  - `settlementAllocations(distribution: object, settlementToken: string): object[]`
  - `describeFailure(leader: object|undefined): string`

- [ ] **Step 1: Add the dependency and fix the package description**

In `scripts/package.json`, change the `description` field and add one dependency:

```json
{
  "name": "@verdikt/scripts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Operational scripts: ENS setup, score publication, and the claimant CLI agents use to file a dispute",
  "scripts": {
    "setup:ens": "node --env-file-if-exists=../.env setup-ens.mjs"
  },
  "dependencies": {
    "@verdikt/fixtures": "workspace:*",
    "@verdikt/sdk": "workspace:*",
    "@verdikt/sla": "workspace:*",
    "genlayer-js": "2.0.0-rc.1",
    "viem": "^2.56.3"
  }
}
```

Then run `pnpm install` from the repo root.

- [ ] **Step 2: Write the failing test**

Create `scripts/genlayer-fees.test.js`:

```javascript
import { describe, expect, it } from 'vitest';
import { MESSAGE_BUDGET, describeFailure, settlementAllocations } from './genlayer-fees.mjs';

const TOKEN = `0x${'ab'.repeat(20)}`;

/** What `estimateFeesDistribution()` returns, in the shape the chain reports. */
const distribution = () => ({
  leaderTimeunitsAllocation: 100n,
  validatorTimeunitsAllocation: 200n,
  appealRounds: 0n,
  executionBudgetPerRound: 25000000000000000n,
  executionConsumed: 0n,
  totalMessageFees: 0n,
  rotations: [3n],
  maxPriceGenPerTimeUnit: 2n,
  storageFeeMaxGasPrice: 300000000n,
  receiptFeeMaxGasPrice: 300000000n
});

describe('settlementAllocations', () => {
  // One entry per call key. `_settle` can emit several `release` messages —
  // bond, compensation, bounty — and they all draw on this one allocation's
  // budget. Listing it per message is AllocationDuplicateKey.
  it('is exactly one allocation', () => {
    expect(settlementAllocations(distribution(), TOKEN)).toHaveLength(1);
  });

  // The key has to name the method. CALL_KEY_UNNAMED is zeros, reads like a
  // wildcard, and matches nothing — giving the same no_matching_allocation
  // the allocation exists to prevent.
  it('names the release method in the call key', () => {
    const [allocation] = settlementAllocations(distribution(), TOKEN);
    expect(allocation.callKey).toMatch(/^0x72656c65617365/);
  });

  it('points at the settlement token it was given', () => {
    const [allocation] = settlementAllocations(distribution(), TOKEN);
    expect(allocation.recipient).toBe(TOKEN);
  });

  // `_settle` emits on='finalized', never on acceptance.
  it('allocates for a finalized message', () => {
    const [allocation] = settlementAllocations(distribution(), TOKEN);
    expect(allocation.onAcceptance).toBe(false);
    expect(allocation.budget).toBe(MESSAGE_BUDGET);
  });
});

describe('describeFailure', () => {
  it('prefers stderr when the VM wrote one', () => {
    expect(describeFailure({ genvm_result: { stderr: 'NameError: gl' } })).toBe('NameError: gl');
  });

  // The case that matters: a consensus-level rejection writes no stderr at
  // all, and reading only stderr reports every one of them as `ERROR`.
  it('decodes the base64 result when stderr is empty', () => {
    const payload = Buffer.from('fee no_matching_allocation # internal').toString('base64');
    expect(describeFailure({ genvm_result: { stderr: '' }, result: payload })).toContain('no_matching_allocation');
  });

  it('reads a structured result object', () => {
    const leader = { result: { status: 'contract_error', payload: 'fee no_matching_allocation # internal' } };
    expect(describeFailure(leader)).toBe('fee no_matching_allocation # internal');
  });

  it('says something rather than nothing when there is no detail at all', () => {
    expect(describeFailure({ execution_result: 'ERROR' })).toBe('ERROR');
    expect(describeFailure(undefined)).toContain('no execution_result');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run scripts/genlayer-fees.test.js`

Expected: FAIL — `Failed to resolve import "./genlayer-fees.mjs"`.

- [ ] **Step 4: Write the module**

Create `scripts/genlayer-fees.mjs`:

```javascript
// The fee and receipt details GenLayer's consensus v0.6 requires, in one place
// because two callers need them: `claim.mjs cancel` and
// `runner/bin/resolve-claims.mjs`. Both route through the judge's `_settle`,
// which emits an internal message to the settlement token.
//
// This logic cost a debugging cycle to get right and fails in
// unrelated-looking ways when it is wrong, so it lives here rather than in two
// copies that can drift apart.

import {
  deriveInternalMessageCallKey,
  encodeInternalMessageFeeParams,
  MessageType,
  MESSAGE_ALLOCATION_ROOT_PARENT_INDEX
} from 'genlayer-js';

/**
 * Fee budget for the settlement messages `_settle` emits. A round number with
 * slack in it, not a measurement: the usual way to size this —
 * `estimateTransactionFeesForWrite` — cannot be used here, because estimating
 * means simulating, and simulating `resolve_claim` runs the LLM judgment.
 * `sim_estimateTransactionFees` answers `execution failed` for exactly that
 * reason. Unspent budget is not consumed.
 */
export const MESSAGE_BUDGET = BigInt(process.env.GENLAYER_MESSAGE_BUDGET ?? 2n * 10n ** 17n);

/**
 * The allocation consensus v0.6 requires for the internal message `_settle`
 * sends to the settlement token.
 *
 * Without it the transaction runs, the validators agree on the judgment, and
 * the whole thing then fails with `fee no_matching_allocation # internal` —
 * the money leg rejected after the judging leg succeeded. So this is not
 * tuning, it is the difference between a claim that settles and one that
 * cannot.
 *
 * Two details that are easy to get wrong and fail in unrelated-looking ways:
 *
 * - `callKey` must *name the method being called* — `release`.
 *   `CALL_KEY_UNNAMED` is zeros and looks like a wildcard but is not one
 *   (`CALL_KEY_WILDCARD` is a different constant), and an unnamed key matches
 *   nothing, giving the same `no_matching_allocation`.
 * - One entry per key. `_settle` can emit several `release` messages — bond,
 *   compensation, bounty — and they all draw on this single allocation's
 *   budget. Listing it once per message is `AllocationDuplicateKey`.
 *
 * @param {Record<string, any>} distribution what `estimateFeesDistribution()` returned
 * @param {string} settlementToken the token `_settle` releases from
 */
export function settlementAllocations(distribution, settlementToken) {
  return [
    {
      messageType: MessageType.Internal,
      // `_settle` emits `on='finalized'`, never on acceptance.
      onAcceptance: false,
      parentIndex: MESSAGE_ALLOCATION_ROOT_PARENT_INDEX,
      recipient: settlementToken,
      callKey: deriveInternalMessageCallKey('release'),
      budget: MESSAGE_BUDGET,
      feeParams: encodeInternalMessageFeeParams({
        leaderTimeunitsAllocation: distribution.leaderTimeunitsAllocation,
        validatorTimeunitsAllocation: distribution.validatorTimeunitsAllocation,
        appealRounds: 0,
        executionBudgetPerRound: distribution.executionBudgetPerRound,
        rotations: [0],
        maxPriceGenPerTimeUnit: distribution.maxPriceGenPerTimeUnit,
        storageFeeMaxGasPrice: distribution.storageFeeMaxGasPrice,
        receiptFeeMaxGasPrice: distribution.receiptFeeMaxGasPrice
      })
    }
  ];
}

/**
 * What actually went wrong, out of a leader receipt.
 *
 * `genvm_result.stderr` is empty for a consensus-level rejection, so reading
 * only that turns every such failure into `ERROR` and hides the cause. The
 * real payload is base64 in `result` — that is where
 * `fee no_matching_allocation # internal` hid while a scheduled job reported
 * nothing useful twice in a row.
 *
 * @param {Record<string, any>|undefined} leader `consensus_data.leader_receipt[0]`
 * @returns {string}
 */
export function describeFailure(leader) {
  const stderr = String(leader?.genvm_result?.stderr ?? '').trim();
  if (stderr) return stderr.slice(0, 300);
  const result = leader?.result;
  if (typeof result === 'string') {
    try {
      return Buffer.from(result, 'base64').toString('utf8').slice(0, 300);
    } catch {
      // Fall through to whatever structured form is there.
    }
  }
  if (result && typeof result === 'object') {
    return String(result.payload ?? result.status ?? JSON.stringify(result)).slice(0, 300);
  }
  return leader?.execution_result ?? 'no execution_result on the leader receipt';
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run scripts/genlayer-fees.test.js`

Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/genlayer-fees.mjs scripts/genlayer-fees.test.js scripts/package.json pnpm-lock.yaml
git commit -m "Share the GenLayer settlement fee logic"
```

---

### Task 2: Point the runner at the shared module

**Files:**
- Modify: `runner/package.json`
- Modify: `runner/bin/resolve-claims.mjs`

**Interfaces:**
- Consumes: `settlementAllocations`, `describeFailure`, `MESSAGE_BUDGET` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Add the workspace dependency**

In `runner/package.json`, add `@verdikt/scripts` alongside the existing deps:

```json
  "dependencies": {
    "@verdikt/scripts": "workspace:*",
    "@verdikt/sdk": "workspace:*",
    "genlayer-js": "2.0.0-rc.1"
  }
```

Run `pnpm install` from the repo root.

- [ ] **Step 2: Replace the local copies with imports**

In `runner/bin/resolve-claims.mjs`:

Change the `genlayer-js` import back to just what the file still uses directly:

```javascript
import { chains, createClient, createAccount } from 'genlayer-js';
```

Add below the existing imports:

```javascript
import { describeFailure, MESSAGE_BUDGET, settlementAllocations } from '@verdikt/scripts/genlayer-fees.mjs';
```

Delete the local `MESSAGE_BUDGET` constant, the local `settlementAllocations` function and the local `describeFailure` function.

Change `resolveOne` to pass the token address, since the shared version takes it as an argument rather than importing the deployment record:

```javascript
    fees: { distribution, messageAllocations: settlementAllocations(distribution, deployment.settlementToken) }
```

- [ ] **Step 3: Add the export path**

`@verdikt/scripts` has no `exports` field, so the subpath import above needs one. In `scripts/package.json` add:

```json
  "exports": {
    "./genlayer-fees.mjs": "./genlayer-fees.mjs"
  },
```

- [ ] **Step 4: Verify the runner still loads and reports correctly**

Run: `node --env-file=runner/.env runner/bin/resolve-claims.mjs`

Expected: it prints `resolver 0x… judge 0x… chain 61997` then `N claim(s) on chain, 0 open` and exits 0. If it throws `ERR_MODULE_NOT_FOUND`, the `exports` entry in Step 3 is wrong or `pnpm install` was not re-run.

- [ ] **Step 5: Commit**

```bash
git add runner/package.json runner/bin/resolve-claims.mjs scripts/package.json pnpm-lock.yaml
git commit -m "Take the runner's fee logic from the shared module"
```

---

### Task 3: The disclosure signature

**Files:**
- Create: `scripts/claim.mjs`
- Create: `scripts/claim.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `DISCLOSURE_PREFIX: string`
  - `disclosureMessage(requestId: string): string`

- [ ] **Step 1: Write the failing test**

Create `scripts/claim.test.js`:

```javascript
import { describe, expect, it } from 'vitest';
import { disclosureMessage, DISCLOSURE_PREFIX } from './claim.mjs';
import { disclosureMessage as proxyDisclosureMessage } from '../proxy/src/evidence.js';

const REQUEST_ID = `0x${'ab'.repeat(32)}`;

// These exact bytes now live in three places: proxy/src/evidence.js,
// genlayer/scripts/claim.py and scripts/claim.mjs. A drift in any one makes
// every disclosure refuse, which reads as a claimant error rather than as the
// bug it is — so the copies are pinned to each other.
describe('the disclosure message', () => {
  it('is the prefix the proxy documents', () => {
    expect(DISCLOSURE_PREFIX).toBe('Verdikt evidence disclosure\nrequest: ');
  });

  it('matches the proxy byte for byte', () => {
    expect(disclosureMessage(REQUEST_ID)).toBe(proxyDisclosureMessage(REQUEST_ID));
  });

  // The judge stores the id lowercased, and a signature over the checksummed
  // form would recover the right key against the wrong message.
  it('lowercases the request id, as the proxy does', () => {
    expect(disclosureMessage(REQUEST_ID.toUpperCase().replace('0X', '0x'))).toBe(
      `${DISCLOSURE_PREFIX}${REQUEST_ID}`
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run scripts/claim.test.js`

Expected: FAIL — `Failed to resolve import "./claim.mjs"`.

- [ ] **Step 3: Write the CLI skeleton with the disclosure message**

Create `scripts/claim.mjs`:

```javascript
// The claimant's CLI, in JavaScript: file a semantic claim and follow it.
//
// `genlayer/scripts/claim.py` is the same tool in Python and stays the one the
// repo's how-to documents. This exists because an agent that wants to dispute a
// call it paid for may have no Python toolchain, and the one this repo uses
// wants a virtualenv, an SDK pinned to a git ref, and a 310MB GenVM artifact
// cache.
//
// It covers the claimant's path only — sign, mint, bond, open, status, cancel.
// Resolving is a bounty hunter's job and `runner/bin/resolve-claims.mjs`
// already does it from a distinct account, which is what keeps a MET outcome
// costing the claimant its bounty. Deposits and withdrawals are the provider's
// side.

import { chains, createAccount, createClient } from 'genlayer-js';
import deployment from '../deployments/genlayer-studio-devnet.json' with { type: 'json' };
import { describeFailure, settlementAllocations } from './genlayer-fees.mjs';

/**
 * Mirrors `disclosureMessage` in proxy/src/evidence.js and DISCLOSURE_PREFIX in
 * genlayer/scripts/claim.py. All three must match byte for byte: the proxy
 * discloses evidence only to whoever signs this exact string, so a drift makes
 * every disclosure refuse.
 */
export const DISCLOSURE_PREFIX = 'Verdikt evidence disclosure\nrequest: ';

/** @param {string} requestId */
export const disclosureMessage = (requestId) => `${DISCLOSURE_PREFIX}${requestId.toLowerCase()}`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run scripts/claim.test.js`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/claim.mjs scripts/claim.test.js
git commit -m "Pin the JS disclosure message to the proxy's"
```

---

### Task 4: Connection, addresses and the write helper

**Files:**
- Modify: `scripts/claim.mjs`

**Interfaces:**
- Consumes: `describeFailure`, `settlementAllocations` from Task 1; `disclosureMessage` from Task 3.
- Produces:
  - `connect(): { client, account }`
  - `addresses(options: { judge?: string, token?: string }): { judge: string, token: string }`
  - `write(client, address: string, functionName: string, args: any[], options?: { allocate?: boolean }): Promise<string>`
  - `showBalance(client, token: string, address: string, label: string): Promise<bigint|null>`

- [ ] **Step 1: Add the helpers**

Append to `scripts/claim.mjs`:

```javascript
/**
 * Consensus on studio_devnet routinely runs past the client's 30s default, and
 * a timeout there is indistinguishable from a failed write to anyone reading
 * the output. Eight minutes is slack, not an estimate.
 */
const WAIT = { interval: 5000, retries: 95 };

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

/** The claimant's client. The key is the account that paid for the call. */
export function connect() {
  const privateKey = process.env.GENLAYER_PRIVATE_KEY;
  if (!privateKey) fail('GENLAYER_PRIVATE_KEY is unset — that key is the claimant');
  const account = createAccount(/** @type {`0x${string}`} */ (privateKey));
  return { client: createClient({ chain: chains.studioDevnet, account }), account };
}

/**
 * The judge and token to act on.
 *
 * `deployments/genlayer-studio-devnet.json` is the source of truth; the flags
 * and the env vars are overrides for a fork or a second deployment, not the
 * normal path. Same precedence, and same reasoning, as
 * `VERDIKT_REGISTRY_ADDRESS` against `deployments/arc-testnet.json`.
 *
 * @param {{ judge?: string, token?: string }} options
 */
export function addresses({ judge, token } = {}) {
  const resolved = {
    judge: judge ?? process.env.GENLAYER_JUDGE_ADDRESS ?? deployment.slaClaimJudge,
    token: token ?? process.env.GENLAYER_TOKEN_ADDRESS ?? deployment.settlementToken
  };
  if (!resolved.judge) fail('no judge address — pass --judge, set GENLAYER_JUDGE_ADDRESS, or deploy first');
  return resolved;
}

/**
 * Send a write and report what consensus actually decided.
 *
 * `waitForTransactionReceipt` returning is not success: the leader receipt
 * carries its own `execution_result`, and an ERROR there means the call
 * reverted inside the VM while the transaction around it is perfectly fine.
 *
 * `allocate` is for the writes that route through the judge's `_settle`, which
 * emits an internal message to the token. Without the allocation consensus
 * rejects the whole transaction as `fee no_matching_allocation # internal`.
 *
 * @param {{ judge: string, token: string }} contracts
 */
export async function write(client, contracts, address, functionName, args, { allocate = false } = {}) {
  const distribution = await client.estimateFeesDistribution();
  const fees = { distribution };
  if (allocate) {
    distribution.totalMessageFees = MESSAGE_BUDGET;
    fees.messageAllocations = settlementAllocations(distribution, contracts.token);
  }
  const hash = await client.writeContract({ address, functionName, args, value: 0n, fees });
  const receipt = await client.waitForTransactionReceipt({ hash, ...WAIT });
  const leader = (receipt?.consensus_data?.leader_receipt ?? [])[0];
  if (leader?.execution_result !== 'SUCCESS') {
    fail(`${functionName} failed: ${describeFailure(leader)}`);
  }
  return hash;
}

/** Read a balance back. A transaction that mined is not one that did anything. */
export async function showBalance(client, token, address, label) {
  if (!token) {
    console.log(`  ${label}: (no token configured)`);
    return null;
  }
  const balance = await client.readContract({ address: token, functionName: 'balance_of', args: [address] });
  const available = await client.readContract({ address: token, functionName: 'available_of', args: [address] });
  console.log(`  ${label}: ${balance} held, ${available} free`);
  return balance;
}
```

Add `MESSAGE_BUDGET` to the existing import from `./genlayer-fees.mjs`:

```javascript
import { describeFailure, MESSAGE_BUDGET, settlementAllocations } from './genlayer-fees.mjs';
```

- [ ] **Step 2: Verify nothing broke**

Run: `pnpm vitest run scripts/claim.test.js && pnpm lint && pnpm typecheck`

Expected: 3 tests PASS, eslint clean, tsc clean.

- [ ] **Step 3: Commit**

```bash
git add scripts/claim.mjs
git commit -m "Add the JS claim CLI's connection and write helpers"
```

---

### Task 5: The subcommands and the argument parser

**Files:**
- Modify: `scripts/claim.mjs`

**Interfaces:**
- Consumes: everything from Tasks 3 and 4.
- Produces: a runnable CLI. No exports other than those already defined.

- [ ] **Step 1: Add the subcommands**

Append to `scripts/claim.mjs`:

```javascript
// ----------------------------------------------------------------- commands

/**
 * The payer's consent to disclose its own purchased response.
 *
 * Signed with the payer's key, which is normally the claimant's: the judge
 * refuses a claim from anyone else and the proxy refuses a disclosure signed by
 * anyone else, so the two checks agree by construction.
 */
async function cmdSign({ requestId }) {
  const { account } = connect();
  const message = disclosureMessage(requestId);
  const signature = await account.signMessage({ message });
  console.log(`payer     ${account.address}`);
  console.log(`message   ${JSON.stringify(message)}`);
  console.log(`signature ${signature}`);
}

async function cmdMint({ amount, ...rest }) {
  const { client, account } = connect();
  const contracts = addresses(rest);
  console.log(`minting ${amount} to ${account.address}`);
  await showBalance(client, contracts.token, account.address, 'before');
  await write(client, contracts, contracts.token, 'mint', [amount]);
  await showBalance(client, contracts.token, account.address, 'after ');
}

/** Hand the judge authority over the bond. The tokens do not move. */
async function cmdBond({ amount, ...rest }) {
  const { client, account } = connect();
  const contracts = addresses(rest);
  const config = await client.readContract({ address: contracts.judge, functionName: 'get_config', args: [] });
  const bond = amount ?? config.bond_amount;
  console.log(`escrowing ${bond} to ${contracts.judge}`);
  await write(client, contracts, contracts.token, 'escrow', [contracts.judge, bond]);
  const escrowed = await client.readContract({
    address: contracts.token,
    functionName: 'escrow_of',
    args: [account.address, contracts.judge]
  });
  console.log(`  escrowed: ${escrowed}`);
  await showBalance(client, contracts.token, account.address, 'balance');
}

async function cmdOpen({ requestId, clause, slug, signature, ...rest }) {
  const { client } = connect();
  const contracts = addresses(rest);
  if (!signature) {
    fail('no --signature — run `claim.mjs sign --request-id …` first; without it evidence stays sealed');
  }
  await write(client, contracts, contracts.judge, 'submit_claim', [requestId, clause, slug, signature]);
  await printClaim(client, contracts.judge, requestId, clause);
}

/** Abandon an open claim. Settles nothing against either side. */
async function cmdCancel({ requestId, clause, ...rest }) {
  const { client } = connect();
  const contracts = addresses(rest);
  // Routes through `_settle` to return the bond, so it needs the allocation.
  await write(client, contracts, contracts.judge, 'cancel_claim', [requestId, clause], { allocate: true });
  await printClaim(client, contracts.judge, requestId, clause);
}

async function cmdStatus({ requestId, clause, ...rest }) {
  const { client } = connect();
  const contracts = addresses(rest);
  await printClaim(client, contracts.judge, requestId, clause);
}

async function printClaim(client, judge, requestId, clause) {
  const claim = await client.readContract({
    address: judge,
    functionName: 'get_claim',
    args: [requestId, clause]
  });
  console.log(JSON.stringify(claim, (key, value) => (typeof value === 'bigint' ? String(value) : value), 2));
}
```

- [ ] **Step 2: Add the argument parser and dispatch**

Append to `scripts/claim.mjs`:

```javascript
// -------------------------------------------------------------------- entry

const USAGE = `usage: claim.mjs <command> [options]

  sign    --request-id 0x…                      the payer's consent to disclose its own response
  mint    [--amount 5000000]                    faucet-mint settlement tokens
  bond    [--amount N]                          escrow the claim bond to the judge
  open    --request-id 0x… --clause ID --slug S --signature 0x…
  status  --request-id 0x… --clause ID          read a claim back
  cancel  --request-id 0x… --clause ID          abandon an open claim once its window has lapsed

  --judge 0x…   --token 0x…                     override deployments/genlayer-studio-devnet.json

GENLAYER_PRIVATE_KEY is the claimant, and must be the payer Arc booked.`;

/** Long flags only, `--flag value` or `--flag=value`. */
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [flag, inline] = arg.slice(2).split('=');
    const camel = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = inline ?? (argv[i + 1]?.startsWith('--') ? undefined : argv[i + 1]);
    options[camel] = value ?? true;
    if (inline === undefined && value !== undefined) i += 1;
  }
  return options;
}

const COMMANDS = {
  sign: cmdSign,
  mint: cmdMint,
  bond: cmdBond,
  open: cmdOpen,
  status: cmdStatus,
  cancel: cmdCancel
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const run = COMMANDS[command];
  if (!run) {
    console.error(USAGE);
    process.exit(command ? 1 : 0);
  }
  const options = parseArgs(rest);
  if (command === 'mint') options.amount = options.amount ? BigInt(options.amount) : 5000000n;
  if (command === 'bond' && options.amount) options.amount = BigInt(options.amount);
  if (command === 'open' && !options.signature) options.signature = process.env.VERDIKT_DISCLOSURE_SIGNATURE;
  await run(options);
}

// Only when run directly, so the test can import the pure helpers.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
```

- [ ] **Step 3: Verify the CLI loads and prints usage**

Run: `node scripts/claim.mjs`

Expected: the usage block, exit 0.

Run: `node scripts/claim.mjs nonsense`

Expected: the usage block, exit 1.

- [ ] **Step 4: Verify the signature matches the Python**

Run both against the same id, with the same key:

```bash
export GENLAYER_PRIVATE_KEY=$(grep '^GENLAYER_PRIVATE_KEY=' genlayer/.env | cut -d= -f2-)
RID=0x5f04b3acedb466143fba24d3e7eeb6e3db9c66e003e62c875be76efb23379b82
node scripts/claim.mjs sign --request-id $RID
cd genlayer && .venv/bin/python scripts/claim.py sign --request-id $RID
```

Expected: identical `payer` and `signature` lines from both. A mismatch means the message bytes differ and every disclosure would refuse.

- [ ] **Step 5: Run the full checks**

Run: `pnpm vitest run && pnpm lint && pnpm typecheck`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/claim.mjs
git commit -m "Add the claimant subcommands to the JS CLI"
```

---

### Task 6: Document it

**Files:**
- Modify: `genlayer/README.md`

**Interfaces:**
- Consumes: the finished CLI.
- Produces: nothing.

- [ ] **Step 1: Note the JS alternative in the claim walkthrough**

In `genlayer/README.md`, directly after the paragraph introducing `scripts/claim.py` under "## Filing a claim", add:

```markdown
`scripts/claim.mjs` in the repo root's `scripts/` is the same claimant path in
JavaScript — `sign`, `mint`, `bond`, `open`, `status`, `cancel` — for an agent
with no Python toolchain. Same flags, same output. It resolves nothing:
`runner/bin/resolve-claims.mjs` does that from a distinct account, which is what
keeps a `MET` outcome costing the claimant its bounty.
```

- [ ] **Step 2: Verify the claim it makes is true**

Run: `node scripts/claim.mjs` and check each of the six commands named above appears in the usage block.

- [ ] **Step 3: Commit**

```bash
git add genlayer/README.md
git commit -m "Point the claim walkthrough at the JS CLI too"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `scripts/claim.mjs`, claimant path only | 3, 5 |
| `scripts/genlayer-fees.mjs` shared with runner | 1, 2 |
| `scripts/claim.test.js` disclosure pin | 3 |
| `scripts/package.json` description fix | 1 |
| Config precedence: record, then flag/env override | 4 (`addresses`) |
| Long wait on writes | 4 (`WAIT`) |
| `execution_result` checked, base64 `result` decoded | 1 (`describeFailure`), 4 (`write`) |
| `genlayer/` stays Python-only | no task touches it except its README |
| Manual cross-check against the Python reference | 5, Step 4 |

**Placeholders:** none — every code step contains the code.

**Type consistency:** `settlementAllocations(distribution, settlementToken)` takes the token as its second argument in Task 1 and is called that way in Task 2 and Task 4. `write(client, contracts, address, functionName, args, options)` is defined in Task 4 and called with that arity throughout Task 5. `describeFailure(leader)` takes the leader receipt, not the whole receipt, in both callers.

**One risk worth naming:** Task 2 Step 3 adds an `exports` map to `@verdikt/scripts`. That makes `./genlayer-fees.mjs` the only importable subpath, so any future cross-package import from `scripts/` needs adding there too. The alternative — no `exports` field — works in pnpm today but relies on unrestricted subpath resolution.
