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
import { createRegistryReader, serviceIdOf } from '@verdikt/sdk';
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

/**
 * The claimant's client. The key is the account that paid for the call.
 *
 * `genlayer/.env`'s `GENLAYER_PRIVATE_KEY` is bare hex, no `0x` — `eth_account`
 * on the Python side accepts that form. `genlayer-js`'s `createAccount` does
 * not: without the prefix it treats the value as an opaque string rather than
 * hex and fails deep inside `@noble/curves` with `invalid private key,
 * expected hex or 32 bytes, got string`. Normalized here so the same env var
 * works for both CLIs unmodified.
 */
export function connect() {
  const raw = process.env.GENLAYER_PRIVATE_KEY;
  if (!raw) fail('GENLAYER_PRIVATE_KEY is unset — that key is the claimant');
  const privateKey = /** @type {`0x${string}`} */ (raw.startsWith('0x') ? raw : `0x${raw}`);
  const account = createAccount(privateKey);
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

/**
 * The request ids a claim can be opened against, newest first.
 *
 * Every other command here takes `--request-id`, and an agent that paid for a
 * call usually does not have one: the proxy mints it as 32 random bytes per
 * request (`proxy/src/router.js`) and returns it only as the
 * `x-verdikt-request-id` response header, which `circle services pay` does not
 * surface and has no flag to. So the id has to be read back off Arc — where it
 * is public, as a `VerdictWritten` topic — and doing that by hand is an
 * `eth_getLogs` scan every disputing agent would otherwise re-derive.
 *
 * This lists calls that were *judged*, not calls that are disputable: a
 * semantic claim needs the SLA to declare a `semantic` clause, which lives on
 * ENS and is not read here.
 */
async function cmdRecent({ blocks, slug, limit }) {
  const rpcUrl = process.env.ARC_RPC_URL;
  // Arc's public RPC refuses the SDK's 10k chunk mid-scan with `-32005 rate
  // limit exceeded`; a credentialed endpoint takes it happily. Same narrowing,
  // and same reasoning, as the paid-call sweep's scripts.
  const registry = createRegistryReader(rpcUrl ? {} : { maxBlockRange: 500n, scanConcurrency: 2 });
  const head = await registry.client.getBlockNumber();
  const fromBlock = head > blocks ? head - blocks : 0n;
  const serviceId = slug ? serviceIdOf(slug) : undefined;
  if (!rpcUrl && !serviceId) {
    console.error(
      '[recent] ARC_RPC_URL unset and no --slug — mapping every serviceId back to a slug\n' +
        '         means scanning ServiceRegistered from the deploy block in 500-block chunks,\n' +
        '         which takes minutes. Set ARC_RPC_URL, or pass --slug to skip that scan.'
    );
  }
  const [verdicts, services] = await Promise.all([
    registry.listVerdicts({ fromBlock, serviceId }),
    // `--slug` already names the only service that can come back, so the
    // slug map — a full-history scan, deliberately unwindowed — is skipped.
    serviceId ? [] : registry.listServices()
  ]);
  const slugOf = new Map(services.map((service) => [service.serviceId, service.slug]));
  const rows = verdicts.slice().reverse().slice(0, limit);
  console.log(`Verdicts in blocks ${fromBlock}..${head}, newest first:\n`);
  for (const verdict of rows) {
    // paidAmount is 6-decimal minor units — the x402 view, not Arc's native 18.
    const paid = `$${(Number(verdict.paidAmount) / 1e6).toFixed(4)}`;
    const name = slug ?? slugOf.get(verdict.serviceId) ?? verdict.serviceId;
    console.log(`${String(verdict.blockNumber).padEnd(10)} ${name.padEnd(14)} ${paid.padStart(8)}  ${verdict.requestId}`);
  }
  if (rows.length === 0) {
    console.log('(none — widen with --blocks, or drop --slug)');
  } else {
    console.log(`\n${rows.length} of ${verdicts.length} · next: claim.mjs sign --request-id <id>`);
  }
}

async function printClaim(client, judge, requestId, clause) {
  const claim = await client.readContract({
    address: judge,
    functionName: 'get_claim',
    args: [requestId, clause]
  });
  console.log(JSON.stringify(claim, (key, value) => (typeof value === 'bigint' ? String(value) : value), 2));
}

// -------------------------------------------------------------------- entry

const USAGE = `usage: claim.mjs <command> [options]

  recent  [--blocks N] [--slug S] [--limit N]   request ids Arc has judged, newest first
  sign    --request-id 0x…                      the payer's consent to disclose its own response
  mint    [--amount 5000000]                    faucet-mint settlement tokens
  bond    [--amount N]                          escrow the claim bond to the judge
  open    --request-id 0x… --clause ID --slug S --signature 0x…
  status  --request-id 0x… --clause ID          read a claim back
  cancel  --request-id 0x… --clause ID          abandon an open claim once its window has lapsed

  --judge 0x…   --token 0x…                     override deployments/genlayer-studio-devnet.json

GENLAYER_PRIVATE_KEY is the claimant, and must be the payer Arc booked.
recent reads Arc instead, so it needs no key — ARC_RPC_URL if you have one.`;

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
  recent: cmdRecent,
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
  if (command === 'recent') {
    // ~3 hours at Arc's two blocks a second: enough to cover a sweep just run,
    // short enough that the scan is a handful of requests rather than hundreds.
    options.blocks = BigInt(options.blocks ?? 20000);
    options.limit = Number(options.limit ?? 20);
  }
  if (command === 'mint') options.amount = options.amount ? BigInt(options.amount) : 5000000n;
  if (command === 'bond' && options.amount) options.amount = BigInt(options.amount);
  if (command === 'open' && !options.signature) options.signature = process.env.VERDIKT_DISCLOSURE_SIGNATURE;
  await run(options);
}

// Only when run directly, so the test can import the pure helpers.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
