// Onboard one service's `<slug>.verdikt.eth` subname (Tasks.md 6.2).
//
// `setup-ens.mjs` prepares the *parent* — the subname registry and the shared
// resolver, once. This is the per-service half, and it is the piece the
// marketplace could not show without: a registered service with no subname has
// no SLA, no endpoint and no scores, so the dashboard shows dashes.
//
// The role grants here are the security boundary Spike A exists to justify, not
// bookkeeping. Two of its findings are load-bearing and easy to undo by
// accident:
//
//   1. The provider gets the subname token and NO registry roles. A provider
//      holding ROLE_SET_RESOLVER could repoint its own subname at a resolver it
//      controls and write `conformance` freely, bypassing the per-key ACL
//      entirely.
//   2. Text keys are granted with `authorizeTextRoles`, per key. The name-wide
//      `authorizeNameRoles` is the other bypass — it would let the provider
//      write the scores it is being judged by.
//
//   node scripts/onboard-service.mjs --slug weather --url https://… [--send]
//
// Without --send it prints the plan and changes nothing.

import { createPublicClient, createWalletClient, http, namehash, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { SEPOLIA } from '@verdikt/sdk/deployments';
import { dnsEncode, resolverRecordsAbi, serviceName } from '@verdikt/sdk/ens';
import { DEFAULT_SEPOLIA_RPC, readNameState, registryAbi, resolverAbi } from './ens-sepolia.mjs';

/** One year. The subname outliving the demo is not interesting; expiring mid-demo is. */
const DURATION_SECONDS = 365 * 24 * 3600;

/** Keys the provider authors, and keys the CRE side authors. Disjoint on purpose. */
const PROVIDER_KEYS = ['sla', 'url'];
const SCORE_KEYS = ['conformance', 'availability'];

function parseArgs(argv) {
  const valueOf = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    send: argv.includes('--send'),
    slug: valueOf('slug'),
    url: valueOf('url'),
    sla: valueOf('sla'),
    payTo: valueOf('pay-to'),
    rpcUrl: valueOf('rpc', process.env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.slug) throw new Error('--slug is required');

  const operatorKey = process.env.ENS_DEPLOYER_PRIVATE_KEY;
  const providerKey = process.env.PROVIDER_PRIVATE_KEY;
  if (!operatorKey || !providerKey) {
    throw new Error('set ENS_DEPLOYER_PRIVATE_KEY and PROVIDER_PRIVATE_KEY');
  }
  const operator = privateKeyToAccount(operatorKey);
  const provider = privateKeyToAccount(providerKey);

  const name = serviceName(args.slug, SEPOLIA.ens.parentName);
  const node = namehash(name);
  const dnsName = dnsEncode(name);
  const subRegistry = SEPOLIA.ens.subnameRegistry;
  const resolver = SEPOLIA.ens.resolver;
  const scoreWriter = SEPOLIA.scoreWriter;
  const payTo = args.payTo ?? provider.address;

  const publicClient = createPublicClient({ chain: sepolia, transport: http(args.rpcUrl) });
  const walletFor = (account) => createWalletClient({ account, chain: sepolia, transport: http(args.rpcUrl) });

  console.log(`  name         ${name}`);
  console.log(`  node         ${node}`);
  console.log(`  subRegistry  ${subRegistry}`);
  console.log(`  resolver     ${resolver}`);
  console.log(`  operator     ${operator.address}`);
  console.log(`  provider     ${provider.address}  (subname owner, writes ${PROVIDER_KEYS.join(' + ')})`);
  console.log(`  scoreWriter  ${scoreWriter ?? '(not deployed)'}  (writes ${SCORE_KEYS.join(' + ')})`);
  console.log(`  payTo        ${payTo}`);

  const state = await readNameState(publicClient, subRegistry, args.slug);
  console.log(`\n  current status: ${state.status}`);

  if (!args.send) {
    console.log('\n  dry run — pass --send to broadcast. It would:');
    console.log(`    1. register "${args.slug}" to the provider with role bitmap 0 (no resolver control)`);
    console.log(`    2. authorizeTextRoles ${PROVIDER_KEYS.join(', ')} -> provider`);
    console.log(`    3. authorizeTextRoles ${SCORE_KEYS.join(', ')} -> score writer`);
    console.log('    4. setAddr(payTo) as the operator');
    console.log('    5. provider writes url and sla');
    return;
  }

  const send = async (account, params) => {
    const { request } = await publicClient.simulateContract({ account, ...params });
    const hash = await walletFor(account).writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`reverted: ${hash}`);
    return hash;
  };

  if (state.status !== 'REGISTERED') {
    // Role bitmap 0: the provider owns the name and controls nothing else.
    // Anything with ROLE_SET_RESOLVER here would hand it the scores (Spike A).
    console.log('\n  minting…');
    await send(operator, {
      address: subRegistry,
      abi: registryAbi,
      functionName: 'register',
      args: [
        args.slug,
        provider.address,
        zeroAddress,
        resolver,
        0n,
        BigInt(Math.floor(Date.now() / 1000) + DURATION_SECONDS)
      ]
    });
    console.log('  minted');
  } else {
    console.log('  already registered — skipping the mint');
  }

  console.log('  granting per-key roles…');
  for (const key of PROVIDER_KEYS) {
    await send(operator, {
      address: resolver,
      abi: resolverAbi,
      functionName: 'authorizeTextRoles',
      args: [dnsName, key, provider.address, true]
    });
  }
  if (scoreWriter) {
    for (const key of SCORE_KEYS) {
      await send(operator, {
        address: resolver,
        abi: resolverAbi,
        functionName: 'authorizeTextRoles',
        args: [dnsName, key, scoreWriter, true]
      });
    }
  }

  // The address record is what the proxy compares a live 402 challenge's payTo
  // against, so it is owner-controlled rather than provider-controlled.
  console.log('  setting the address record…');
  await send(operator, { address: resolver, abi: resolverRecordsAbi, functionName: 'setAddr', args: [node, payTo] });

  if (args.url) {
    console.log('  provider writing url…');
    await send(provider, {
      address: resolver,
      abi: resolverRecordsAbi,
      functionName: 'setText',
      args: [node, 'url', args.url]
    });
  }
  if (args.sla) {
    console.log('  provider writing sla…');
    await send(provider, {
      address: resolver,
      abi: resolverRecordsAbi,
      functionName: 'setText',
      args: [node, 'sla', args.sla]
    });
  }

  console.log(`\nDone. Confirm with:  node -e "import('@verdikt/sdk').then(m=>m.resolveServiceRecord('${args.slug}').then(console.log))"`);
}

main().catch((error) => {
  console.error(`\nonboarding failed: ${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
