// The end-to-end loop, runnable today (Tasks.md §6.2, issue #12).
//
// WHY THIS RUNS ON ANVIL AND NOT ARC TESTNET
//
// Tasks.md 2.4 is blocked: there is no `ARC_RPC_URL` and no funded deployer
// key in this checkout, so nothing here can deploy to Arc. Rather than leave
// the whole loop undemonstrated, this runs it against a local chain, where
// every part that does not depend on Arc specifically is identical: the same
// contract bytecode, the same report encoding, the same refund arithmetic, the
// same proxy code path.
//
// What it therefore does NOT prove, and the submission should not claim:
//   - anything about Arc's own behaviour (it is EVM-compatible; that is the
//     assumption being leaned on);
//   - that a real KeystoneForwarder delivers a report this contract accepts —
//     the 109-byte metadata offsets are still unverified against a live one
//     (Tasks.md 2.4);
//   - that a real x402 payment settles, since Spike C has not run and
//     `decodePayment` is a fixture stub.
//
// Point it at a deployed registry with --rpc/--registry once 2.4 unblocks.
//
//   node scripts/demo.mjs

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, http, parseAbi, parseAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { serviceIdOf } from '@verdikt/sdk';

const ARTIFACT = new URL('../contracts/out/VerdiktRegistry.sol/VerdiktRegistry.json', import.meta.url);

/** anvil's first two deterministic accounts. Local only, and famously public. */
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PROVIDER = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const AGENT = '0x1111111111111111111111111111111111111111';

const DEPOSIT = 10n * 10n ** 18n; // 10 USDC in Arc's 18-decimal native view
const REFUND = 10n ** 18n; // 1 USDC
const PAID_MINOR = 2_500_000n; // 2.5 USDC, in the 6-decimal x402 view

const OUTCOME = { PASS: 0, FAIL: 1, DOWN: 2 };

const registryAbi = parseAbi([
  'function register(string slug) payable returns (bytes32)',
  'function topUp(bytes32 serviceId) payable',
  'function onReport(bytes metadata, bytes report)',
  'function withdraw() returns (uint256)',
  'function getService(bytes32 serviceId) view returns ((address provider, uint8 status, uint256 deposit))',
  'function getOwed(address payer) view returns (uint256)',
  'function NATIVE_PER_MINOR_UNIT() view returns (uint256)'
]);

const REPORT = parseAbiParameters('bytes32 serviceId, bytes32 requestId, uint8 outcome, address payer, uint256 paidAmount');

const localChain = (id) =>
  defineChain({
    id,
    name: 'demo',
    nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [] } }
  });

const usdc = (value) => `${(Number(value) / 1e18).toFixed(2)} USDC`;
const STATUS = ['NONE', 'ACTIVE', 'SUSPENDED', 'DEREGISTERED'];

let step = 0;
const say = (message) => console.log(`\n${String(++step).padStart(2, ' ')}. ${message}`);
const detail = (message) => console.log(`    ${message}`);

/**
 * The forwarder metadata a KeystoneForwarder would prepend. 109 bytes, with
 * `workflowOwner` at offset 87 — the field the registry pins, because the
 * forwarder is shared infrastructure and `msg.sender` alone is not access
 * control (Spike B, CRE-2).
 */
function metadata(workflowOwner) {
  const bytes = new Uint8Array(109);
  const owner = workflowOwner.slice(2).match(/../g).map((byte) => parseInt(byte, 16));
  bytes.set(owner, 87);
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

async function startAnvil() {
  const port = 8700 + Math.floor(Math.random() * 200);
  const child = spawn('anvil', ['--port', String(port), '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error('anvil exited; is it on PATH? (~/.foundry/bin)');
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
      });
      if (response.ok) return { url, child, chainId: Number((await response.json()).result) };
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  child.kill();
  throw new Error('anvil did not become ready');
}

async function main() {
  const anvil = await startAnvil();
  try {
    const chain = localChain(anvil.chainId);
    const transport = http(anvil.url);
    const publicClient = createPublicClient({ chain, transport });
    const deployer = privateKeyToAccount(DEPLOYER);
    const provider = privateKeyToAccount(PROVIDER);
    const deployerWallet = createWalletClient({ account: deployer, chain, transport });
    const providerWallet = createWalletClient({ account: provider, chain, transport });

    const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));

    // The deployer stands in for both the forwarder and the workflow owner. On
    // Arc these are the real KeystoneForwarder and Verdikt's CRE account;
    // production enrollment is private beta, so attestation is simulated and
    // the submission says so rather than implying otherwise.
    say('Deploy VerdiktRegistry (forwarder and workflow owner stood in by a local key)');
    const deployHash = await deployerWallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [deployer.address, deployer.address, `0x${'00'.repeat(10)}`, DEPOSIT, REFUND]
    });
    const registry = (await publicClient.waitForTransactionReceipt({ hash: deployHash })).contractAddress;
    detail(`registry ${registry}`);
    detail(`bond ${usdc(DEPOSIT)} per service, refund capped at ${usdc(REFUND)} per failed call`);

    const write = async (wallet, functionName, args, value) => {
      const hash = await wallet.writeContract({ address: registry, abi: registryAbi, functionName, args, value });
      return publicClient.waitForTransactionReceipt({ hash });
    };
    const read = (functionName, args) =>
      publicClient.readContract({ address: registry, abi: registryAbi, functionName, args });

    say('Register two services: one that honours its SLA, one whose twin cannot');
    for (const slug of ['weather', 'weather-lite']) {
      await write(providerWallet, 'register', [slug], DEPOSIT);
      detail(`${slug} → ${serviceIdOf(slug)}`);
    }
    const honest = serviceIdOf('weather');
    const twin = serviceIdOf('weather-lite');

    const deliver = async (serviceId, outcome, nonce) => {
      const requestId = `0x${nonce.toString(16).padStart(64, '0')}`;
      await write(deployerWallet, 'onReport', [
        metadata(deployer.address),
        encodeAbiParameters(REPORT, [serviceId, requestId, outcome, AGENT, PAID_MINOR])
      ]);
    };

    say('Happy path — three conforming calls on `weather`');
    for (let i = 0; i < 3; i += 1) await deliver(honest, OUTCOME.PASS, 1 + i);
    detail(`deposit untouched: ${usdc((await read('getService', [honest])).deposit)}`);
    detail(`agent owed: ${usdc(await read('getOwed', [AGENT]))} — a PASS credits nothing`);

    say('Violating twin — every call breaks its own published SLA');
    for (let i = 0; i < 9; i += 1) await deliver(twin, OUTCOME.FAIL, 100 + i);
    let state = await read('getService', [twin]);
    detail(`after 9 failures: deposit ${usdc(state.deposit)}, status ${STATUS[state.status]}`);
    detail(`agent owed: ${usdc(await read('getOwed', [AGENT]))}`);

    say('Drive the bond to zero — this is what gives a verdict teeth');
    await deliver(twin, OUTCOME.FAIL, 200);
    state = await read('getService', [twin]);
    detail(`deposit ${usdc(state.deposit)}, status ${STATUS[state.status]}`);
    if (STATUS[state.status] !== 'SUSPENDED') throw new Error('expected the drained service to auto-suspend');

    say('A refund larger than the payment is impossible, by construction');
    const scale = await read('NATIVE_PER_MINOR_UNIT', []);
    const owed = await read('getOwed', [AGENT]);
    const paidTotal = PAID_MINOR * scale * 10n;
    detail(`agent paid ${usdc(paidTotal)} across 10 failed calls and is owed ${usdc(owed)}`);
    if (owed > paidTotal) throw new Error('refund exceeded what was paid — the griefing cap is broken');
    detail('griefing is break-even-minus-gas: the cap held');

    say('A DOWN refunds too — that call took payment and delivered nothing');
    await deliver(honest, OUTCOME.DOWN, 300);
    detail(`weather deposit now ${usdc((await read('getService', [honest])).deposit)}`);

    say('Pull payment — the agent collects what was booked for it');
    // The payer in the reports above is a fixture address nobody holds a key
    // for, so the withdrawal runs from an address that earned its own credit.
    const agentAccount = privateKeyToAccount(`0x${'22'.repeat(32)}`);
    await write(deployerWallet, 'onReport', [
      metadata(deployer.address),
      encodeAbiParameters(REPORT, [honest, `0x${'0'.repeat(63)}5`, OUTCOME.FAIL, agentAccount.address, PAID_MINOR])
    ]);
    const booked = await read('getOwed', [agentAccount.address]);
    detail(`booked, not sent: owed ${usdc(booked)} before withdrawing`);

    // Gas money only — anvil funds its own accounts, not this one.
    const funding = await deployerWallet.sendTransaction({ to: agentAccount.address, value: 10n ** 18n });
    await publicClient.waitForTransactionReceipt({ hash: funding });
    const before = await publicClient.getBalance({ address: agentAccount.address });
    const receipt = await write(createWalletClient({ account: agentAccount, chain, transport }), 'withdraw', []);
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    const received = (await publicClient.getBalance({ address: agentAccount.address })) - before + gas;
    detail(`received ${usdc(received)} net of gas; owed now ${usdc(await read('getOwed', [agentAccount.address]))}`);
    if (received !== booked) throw new Error(`withdrew ${received}, expected the booked ${booked}`);

    say('Summary');
    for (const [slug, id] of [
      ['weather', honest],
      ['weather-lite', twin]
    ]) {
      const service = await read('getService', [id]);
      detail(`${slug.padEnd(13)} ${STATUS[service.status].padEnd(11)} bond ${usdc(service.deposit)}`);
    }
    console.log('\n✓ register → verify → refund → suspend, end to end.');
    console.log('  Not on Arc: 2.4 is blocked on an RPC URL and a funded key. See the header of this file.');
  } finally {
    anvil.child.kill();
  }
}

main().catch((error) => {
  console.error(`\ndemo failed: ${error.message}`);
  process.exitCode = 1;
});
