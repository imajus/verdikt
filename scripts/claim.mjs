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
import { describeFailure, MESSAGE_BUDGET, settlementAllocations } from './genlayer-fees.mjs';

/**
 * Mirrors `disclosureMessage` in proxy/src/evidence.js and DISCLOSURE_PREFIX in
 * genlayer/scripts/claim.py. All three must match byte for byte: the proxy
 * discloses evidence only to whoever signs this exact string, so a drift makes
 * every disclosure refuse.
 */
export const DISCLOSURE_PREFIX = 'Verdikt evidence disclosure\nrequest: ';

/** @param {string} requestId */
export const disclosureMessage = (requestId) => `${DISCLOSURE_PREFIX}${requestId.toLowerCase()}`;

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
