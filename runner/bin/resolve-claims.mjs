// Resolve every open semantic claim on GenLayer, once, then exit.
//
// WHY THIS EXISTS
//
// `SlaClaimJudge.resolve_claim` is permissionless by design: whoever sends it
// earns the bounty (docs/GenLayer.md). That is a market, not a
// scheduler — GenLayer validators judge the content *inside* the call, but
// nothing triggers the call itself. Until someone does, a filed claim sits
// OPEN forever. This is the bounty hunter that keeps the demo moving.
//
// WHY A THIRD PARTY HAS TO BE THE ONE CALLING IT
//
// On a MET outcome `_settle` releases the bounty out of the *claimant's* bond
// to the resolver. Resolve with the claimant's own key and that becomes
// `release(claimant, claimant, …)` — a debit and a credit to one balance — so
// a MET claim costs the claimant nothing and the deterrent against junk
// claims silently stops existing. This process is a distinct account, which
// is what makes that half real. It refuses to resolve its own claims for the
// same reason.
//
// WHY IT RUNS ONCE AND EXITS
//
// Same shape as `publish-scores.sh`: the schedule lives in Dokploy, which
// runs a scheduled job as `docker exec <container> <command>`. The container
// needs no scheduler of its own, only a command worth exec'ing, versioned
// here rather than typed into a UI text box. See README.md.
//
// WHY genlayer-js IS PINNED TO THE 2.x RELEASE CANDIDATE
//
// `genlayer-js@1.1.8` — what `web/` pins — cannot write to Studio Dev at all.
// Consensus v0.6 rejects a write carrying no explicit fee distribution, and
// 1.x exposes no way to supply one, so every write comes back as a bare
// "transaction reverted" against the consensus contract. Verified against the
// live chain, not inferred. The 2.0.0-rc.1 line adds `fees` and
// `estimateFeesDistribution`, and ships `studioDevnet` as a real chain rather
// than something to hand-build. `web/` stays on 1.x deliberately: it only
// reads, where 1.x is fine.

import {
  chains,
  createClient,
  createAccount,
  deriveInternalMessageCallKey,
  encodeInternalMessageFeeParams,
  MessageType,
  MESSAGE_ALLOCATION_ROOT_PARENT_INDEX
} from 'genlayer-js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import deployment from '../../deployments/genlayer-studio-devnet.json' with { type: 'json' };

/** Claims that failed this many times in a row are left alone. */
const MAX_ATTEMPTS = Number(process.env.RESOLVER_MAX_ATTEMPTS ?? 3);
/** Survives between runs so a poisoned claim is not retried forever. */
const STATE_PATH = process.env.RESOLVER_STATE_PATH ?? '/tmp/verdikt-resolver-state.json';
const DRY_RUN = process.argv.includes('--dry-run');

const stamp = () => new Date().toISOString();
const log = (...parts) => console.log(`resolve-claims: ${stamp()}`, ...parts);

/**
 * A claim is ours to act on only while it is OPEN. `resolve_claim` raises on
 * anything else (`_require_open`), so filtering here is what keeps a settled
 * claim from burning a transaction to be told it is settled.
 */
const isOpen = (claim) => claim?.resolved !== true && String(claim?.outcome ?? 'OPEN') === 'OPEN';

const key = (claim) => `${claim.request_id}:${claim.clause_id}`;

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch {
    // A missing or unreadable state file means "nothing has failed yet", which
    // is the correct starting point and never a reason to refuse to run.
    return {};
  }
}

async function saveState(state) {
  try {
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    log('WARN could not persist attempt state:', err.message);
  }
}

/**
 * Fee budget for the settlement messages `_settle` emits. A round number with
 * slack in it, not a measurement: the usual way to size this —
 * `estimateTransactionFeesForWrite` — cannot be used here, because estimating
 * means simulating, and simulating `resolve_claim` runs the LLM judgment.
 * `sim_estimateTransactionFees` answers `execution failed` for exactly that
 * reason. Unspent budget is not consumed.
 */
const MESSAGE_BUDGET = BigInt(process.env.RESOLVER_MESSAGE_BUDGET ?? 2n * 10n ** 17n);

/**
 * The allocation consensus v0.6 requires for the internal message `_settle`
 * sends to the settlement token.
 *
 * Without it the transaction runs, the validators agree on the judgment, and
 * the whole thing then fails with `fee no_matching_allocation # internal` —
 * the money leg rejected after the judging leg succeeded. So this is not
 * tuning, it is the difference between a claim that resolves and one that
 * cannot.
 *
 * Two details that are easy to get wrong and fail in unrelated-looking ways:
 *
 * - `callKey` must *name the method being called* — `release`. `CALL_KEY_UNNAMED`
 *   is zeros and looks like a wildcard but is not one (`CALL_KEY_WILDCARD` is a
 *   different constant), and an unnamed key matches nothing, giving the same
 *   `no_matching_allocation`.
 * - One entry per key. `_settle` can emit several `release` messages — bond,
 *   compensation, bounty — and they all draw on this single allocation's
 *   budget. Listing it once per message is `AllocationDuplicateKey`.
 */
function settlementAllocations(distribution) {
  return [
    {
      messageType: MessageType.Internal,
      // `_settle` emits `on='finalized'`, never on acceptance.
      onAcceptance: false,
      parentIndex: MESSAGE_ALLOCATION_ROOT_PARENT_INDEX,
      recipient: deployment.settlementToken,
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
 * only that turns every such failure into the log line `ERROR: ERROR`. The
 * real payload is base64 in `result` — that is where
 * `fee no_matching_allocation # internal` was hiding while this script
 * reported nothing useful twice in a row.
 */
function describeFailure(leader) {
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

/**
 * Send the write and report what consensus actually decided.
 *
 * `waitForTransactionReceipt` returning is not success. The leader receipt
 * carries its own `execution_result`, and an ERROR there means the call
 * reverted inside the VM while the transaction around it looks perfectly
 * healthy — the GenLayer version of the forwarder trap this repo already
 * learned once (CLAUDE.md, "Two silent failures").
 */
async function resolveOne(client, claim) {
  const distribution = await client.estimateFeesDistribution();
  distribution.totalMessageFees = MESSAGE_BUDGET;

  const hash = await client.writeContract({
    address: deployment.slaClaimJudge,
    functionName: 'resolve_claim',
    args: [claim.request_id, claim.clause_id],
    value: 0n,
    fees: { distribution, messageAllocations: settlementAllocations(distribution) }
  });
  const receipt = await client.waitForTransactionReceipt({ hash, interval: 3000, retries: 80 });
  const leader = receipt?.consensus_data?.leader_receipt ?? [];
  const result = leader[0]?.execution_result;
  if (result !== 'SUCCESS') {
    throw new Error(`execution_result=${result}: ${describeFailure(leader[0])}`);
  }
  return hash;
}

async function main() {
  const privateKey = process.env.GENLAYER_RESOLVER_PRIVATE_KEY;
  // Refuse rather than run without it. A resolver with no key reads the claim
  // list, resolves nothing, and exits 0 — indistinguishable in the logs from a
  // run where there was simply nothing to do.
  if (!privateKey) {
    console.error('resolve-claims: GENLAYER_RESOLVER_PRIVATE_KEY is unset — the run would read the claims and resolve nothing');
    process.exit(1);
  }

  const account = createAccount(/** @type {`0x${string}`} */ (privateKey));
  const client = createClient({ chain: chains.studioDevnet, account });
  log(`resolver ${account.address} judge ${deployment.slaClaimJudge} chain ${chains.studioDevnet.id}${DRY_RUN ? ' (dry run)' : ''}`);

  const claims = await client.readContract({
    address: deployment.slaClaimJudge,
    functionName: 'list_claims',
    args: []
  });
  const all = Array.isArray(claims) ? claims : [];
  const open = all.filter(isOpen);
  log(`${all.length} claim(s) on chain, ${open.length} open`);
  if (open.length === 0) return;

  const state = await loadState();
  let resolved = 0;
  let failed = 0;

  for (const claim of open) {
    const id = key(claim);
    const attempts = state[id]?.attempts ?? 0;
    if (attempts >= MAX_ATTEMPTS) {
      log(`SKIP ${id} — ${attempts} consecutive failures, leaving it for a human`);
      continue;
    }
    // Resolving our own claim would make the MET bounty a transfer to
    // ourselves and quietly void the cost of filing. We are a bounty hunter,
    // not a party to the dispute.
    if (String(claim.claimant ?? '').toLowerCase() === account.address.toLowerCase()) {
      log(`SKIP ${id} — this resolver is the claimant; a self-resolved MET costs the claimant nothing`);
      continue;
    }

    if (DRY_RUN) {
      log(`WOULD RESOLVE ${id} slug=${claim.slug}`);
      continue;
    }

    try {
      log(`resolving ${id} slug=${claim.slug}`);
      const hash = await resolveOne(client, claim);
      // Read it back rather than trusting the write: the outcome is the point,
      // and it is what the dashboard and the claimant will see.
      const after = await client.readContract({
        address: deployment.slaClaimJudge,
        functionName: 'get_claim',
        args: [claim.request_id, claim.clause_id]
      });
      log(`OK ${id} -> ${after?.outcome} (compensation=${after?.compensation} bounty=${after?.bounty}) tx=${hash}`);
      delete state[id];
      resolved += 1;
    } catch (err) {
      failed += 1;
      state[id] = { attempts: attempts + 1, lastError: String(err.message).slice(0, 300), at: stamp() };
      log(`FAIL ${id} (attempt ${attempts + 1}/${MAX_ATTEMPTS}): ${err.message}`);
    }
  }

  await saveState(state);
  log(`done — ${resolved} resolved, ${failed} failed`);
  // A run that could not resolve anything it tried is a real operational
  // problem, and a scheduled job that exits 0 regardless is how it stays
  // invisible.
  if (resolved === 0 && failed > 0) process.exit(1);
}

await main();
