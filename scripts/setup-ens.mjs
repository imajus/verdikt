#!/usr/bin/env node
// One-time ENS setup for the Verdikt namespace on Sepolia (Specification.md §4).
//
// WHAT THIS DOES
//
// Spike A established that `<slug>.verdikt.eth` cannot exist until two things
// are true, and neither follows from owning `verdikt.eth`:
//
//   1. The name points at a subregistry. ENSv2's registry is hierarchical —
//      without a `UserRegistry` under `verdikt.eth` there is nowhere to mint a
//      provider's subname. It also needs the *backward* `setParent` pointer, or
//      UniversalResolverV2 cannot resolve through the hierarchy.
//   2. The operator holds the resolver's ROOT_RESOURCE roles. Resolvers are
//      per-account, so these do NOT transfer with the name: a transferred name
//      still points at the previous holder's resolver, and the new owner can
//      write nothing. Deploying the operator's own resolver is the clean fix —
//      it also leaves no earlier address with standing write access to the SLA
//      records, which a `grantRoles` top-up would.
//
// Every step is idempotent: state is read first and anything already correct is
// skipped, so re-running after a partial failure resumes rather than reverts.
//
// HOW IT RUNS
//
//   node scripts/setup-ens.mjs           # plan: dry-run on a fork, print calldata
//   node scripts/setup-ens.mjs --send    # broadcast to Sepolia
//
// The default is a rehearsal on an anvil fork of Sepolia. Because a
// VerifiableFactory proxy address is fully determined by (factory, sender,
// salt), the addresses a fork run produces are the addresses a live run will
// produce — so the printed `to`/`data` pairs can be signed from any wallet
// instead of running `--send` at all.
//
// `--send` reads ENS_DEPLOYER_PRIVATE_KEY from the environment (put it in
// `.env`, which is gitignored) and refuses to run unless that key's address is
// the configured operator. It rehearses on a fork first and stops if the
// rehearsal fails, so a broken sequence is never broadcast.

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  namehash,
  parseEventLogs,
  zeroAddress
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import {
  ALL_ROLES,
  DEFAULT_SEPOLIA_RPC,
  RESOLVER_ROLES_VERDIKT_NEEDS,
  SEPOLIA_ENSV2,
  STATUS,
  anyId,
  factoryAbi,
  proxySalt,
  registryAbi,
  resolverAbi,
  rpc,
  startAnvil
} from './ens-sepolia.mjs';

function parseArgs(argv) {
  const valueOf = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    send: argv.includes('--send'),
    parentLabel: valueOf('parent', (process.env.ENS_PARENT_NAME ?? 'verdikt.eth').replace(/\.eth$/, '')),
    operator: valueOf('operator', process.env.ENS_OPERATOR_ADDRESS),
    rpcUrl: valueOf('rpc', process.env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC)
  };
}

/**
 * Read the current state of the parent name. Everything the plan branches on
 * comes from here, so a re-run after a partial setup sees what actually landed.
 */
async function readState(publicClient, parentLabel, operator) {
  const id = anyId(parentLabel);
  const [status, owner, resolver, subregistry] = await Promise.all([
    publicClient.readContract({
      address: SEPOLIA_ENSV2.ETHRegistry,
      abi: registryAbi,
      functionName: 'getStatus',
      args: [id]
    }),
    publicClient.readContract({
      address: SEPOLIA_ENSV2.ETHRegistry,
      abi: registryAbi,
      functionName: 'findOwner',
      args: [parentLabel]
    }),
    publicClient.readContract({
      address: SEPOLIA_ENSV2.ETHRegistry,
      abi: registryAbi,
      functionName: 'getResolver',
      args: [parentLabel]
    }),
    publicClient.readContract({
      address: SEPOLIA_ENSV2.ETHRegistry,
      abi: registryAbi,
      functionName: 'getSubregistry',
      args: [parentLabel]
    })
  ]);

  // A resolver is only usable if the operator can actually write through it.
  let resolverOperable = false;
  if (resolver !== zeroAddress) {
    try {
      resolverOperable = await publicClient.readContract({
        address: resolver,
        abi: resolverAbi,
        functionName: 'hasRootRoles',
        args: [RESOLVER_ROLES_VERDIKT_NEEDS, operator]
      });
    } catch {
      // Not a PermissionedResolver at all — treat as unusable.
      resolverOperable = false;
    }
  }

  return { status: STATUS[status], owner, resolver, subregistry, resolverOperable };
}

/**
 * Run the setup against whichever chain `send` is bound to, recording each
 * transaction so the caller can print it. Skips anything already in place.
 */
async function runSetup({ publicClient, send, operator, parentLabel }) {
  const parentName = `${parentLabel}.eth`;
  const id = anyId(parentLabel);
  const txs = [];
  const state = await readState(publicClient, parentLabel, operator);

  if (state.status !== 'REGISTERED') {
    throw new Error(`${parentName} is ${state.status} on Sepolia ENSv2 — register it first`);
  }
  if (state.owner.toLowerCase() !== operator.toLowerCase()) {
    throw new Error(`${parentName} is owned by ${state.owner}, not the operator ${operator}`);
  }

  // ---- 1. a resolver the operator controls
  let resolverAddress = state.resolver;
  if (state.resolverOperable) {
    console.log(`  skip   resolver — ${resolverAddress} already operable by the operator`);
  } else {
    if (state.resolver !== zeroAddress) {
      console.log(
        `  note   ${state.resolver} is attached but the operator holds none of its root roles`
      );
    }
    const tx = {
      title: 'deploy the operator\'s PermissionedResolver',
      to: SEPOLIA_ENSV2.VerifiableFactory,
      data: encodeFunctionData({
        abi: factoryAbi,
        functionName: 'deployProxy',
        args: [
          SEPOLIA_ENSV2.PermissionedResolverImpl,
          proxySalt('OwnedResolver', 'address', operator),
          encodeFunctionData({
            abi: resolverAbi,
            functionName: 'initialize',
            args: [operator, ALL_ROLES, []]
          })
        ]
      })
    };
    const receipt = await send(tx);
    const [log] = parseEventLogs({ abi: factoryAbi, eventName: 'ProxyDeployed', logs: receipt.logs });
    resolverAddress = log.args.proxyAddress;
    txs.push({ ...tx, result: resolverAddress });
    console.log(`  done   resolver ${resolverAddress}`);

    const point = {
      title: `point ${parentName} at that resolver`,
      to: SEPOLIA_ENSV2.ETHRegistry,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: 'setResolver',
        args: [id, resolverAddress]
      })
    };
    await send(point);
    txs.push(point);
    console.log('  done   setResolver');
  }

  // ---- 2. a subregistry, so subnames can exist at all
  let subRegistryAddress = state.subregistry;
  if (subRegistryAddress !== zeroAddress) {
    console.log(`  skip   subregistry — ${subRegistryAddress} already set`);
  } else {
    const tx = {
      title: `deploy the UserRegistry for ${parentName}`,
      to: SEPOLIA_ENSV2.VerifiableFactory,
      data: encodeFunctionData({
        abi: factoryAbi,
        functionName: 'deployProxy',
        args: [
          SEPOLIA_ENSV2.UserRegistryImpl,
          proxySalt('UserRegistry', 'bytes32', namehash(parentName)),
          encodeFunctionData({
            abi: registryAbi,
            functionName: 'initialize',
            args: [operator, ALL_ROLES]
          })
        ]
      })
    };
    const receipt = await send(tx);
    const [log] = parseEventLogs({ abi: factoryAbi, eventName: 'ProxyDeployed', logs: receipt.logs });
    subRegistryAddress = log.args.proxyAddress;
    txs.push({ ...tx, result: subRegistryAddress });
    console.log(`  done   subregistry ${subRegistryAddress}`);

    const point = {
      title: `point ${parentName} at that subregistry`,
      to: SEPOLIA_ENSV2.ETHRegistry,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: 'setSubregistry',
        args: [id, subRegistryAddress]
      })
    };
    await send(point);
    txs.push(point);
    console.log('  done   setSubregistry');
  }

  // ---- 3. the backward pointer UniversalResolverV2 walks
  const [parentRegistry, parentLabelOnChain] = await publicClient.readContract({
    address: subRegistryAddress,
    abi: registryAbi,
    functionName: 'getParent'
  });
  const parentWired =
    parentRegistry.toLowerCase() === SEPOLIA_ENSV2.ETHRegistry && parentLabelOnChain === parentLabel;
  if (parentWired) {
    console.log('  skip   setParent — backward pointer already correct');
  } else {
    const tx = {
      title: 'set the subregistry\'s backward pointer (required for resolution)',
      to: subRegistryAddress,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: 'setParent',
        args: [SEPOLIA_ENSV2.ETHRegistry, parentLabel]
      })
    };
    await send(tx);
    txs.push(tx);
    console.log('  done   setParent');
  }

  return { txs, resolverAddress, subRegistryAddress };
}

/** Confirm the end state independently of the steps that produced it. */
async function verify(publicClient, parentLabel, operator, expected) {
  const state = await readState(publicClient, parentLabel, operator);
  const problems = [];
  if (state.resolver.toLowerCase() !== expected.resolverAddress.toLowerCase()) {
    problems.push(`resolver is ${state.resolver}, expected ${expected.resolverAddress}`);
  }
  if (!state.resolverOperable) {
    problems.push(`operator ${operator} cannot write through ${state.resolver}`);
  }
  if (state.subregistry.toLowerCase() !== expected.subRegistryAddress.toLowerCase()) {
    problems.push(`subregistry is ${state.subregistry}, expected ${expected.subRegistryAddress}`);
  }
  const [parentRegistry, parentLabelOnChain] = await publicClient.readContract({
    address: state.subregistry,
    abi: registryAbi,
    functionName: 'getParent'
  });
  if (parentRegistry.toLowerCase() !== SEPOLIA_ENSV2.ETHRegistry || parentLabelOnChain !== parentLabel) {
    problems.push(`backward pointer is (${parentRegistry}, "${parentLabelOnChain}")`);
  }
  if (problems.length) throw new Error(problems.join('; '));
}

function printPlan(txs, parentLabel) {
  if (!txs.length) {
    console.log('\nNothing to do — the namespace is already set up.');
    return;
  }
  console.log(`\nTransactions to sign, in order, from the operator address:\n`);
  txs.forEach((tx, i) => {
    console.log(`  ${i + 1}. ${tx.title}`);
    console.log(`     to    ${tx.to}`);
    console.log(`     value 0`);
    console.log(`     data  ${tx.data}`);
    if (tx.result) console.log(`     -> deploys ${tx.result}`);
    console.log();
  });
  console.log(
    `Addresses above are what a live run will produce: a VerifiableFactory proxy\n` +
      `address is fixed by (factory, sender, salt), so the fork predicts it exactly.\n` +
      `Sign these from any wallet, or run with --send.\n\n` +
      `Afterwards, put the two deployed addresses in .env as\n` +
      `ENS_RESOLVER_ADDRESS and ENS_SUBNAME_REGISTRY_ADDRESS, then confirm with\n` +
      `  pnpm spike:ens --read-only --parent ${parentLabel}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.operator) {
    throw new Error('set ENS_OPERATOR_ADDRESS (or pass --operator 0x…)');
  }

  let liveAccount = null;
  if (args.send) {
    const key = process.env.ENS_DEPLOYER_PRIVATE_KEY;
    if (!key) {
      throw new Error('--send needs ENS_DEPLOYER_PRIVATE_KEY in the environment (put it in .env)');
    }
    liveAccount = privateKeyToAccount(key);
    if (liveAccount.address.toLowerCase() !== args.operator.toLowerCase()) {
      // Never broadcast from a key that is not the configured operator: the
      // proxy salt mixes msg.sender, so a different signer silently deploys a
      // different resolver at a different address.
      throw new Error(
        `ENS_DEPLOYER_PRIVATE_KEY is ${liveAccount.address}, not the operator ${args.operator}`
      );
    }
  }

  console.log('Verdikt ENS setup — Sepolia ENSv2');
  console.log(`  parent      ${args.parentLabel}.eth`);
  console.log(`  operator    ${args.operator}`);
  console.log(`  mode        ${args.send ? 'send (broadcasts after a fork rehearsal)' : 'plan (fork only)'}`);

  // ---- rehearse on a fork, always
  console.log('\nRehearsing on an anvil fork of Sepolia');
  const anvil = await startAnvil(args.rpcUrl);
  let rehearsed;
  try {
    const forkClient = createPublicClient({ chain: sepolia, transport: http(anvil.url) });
    await rpc(anvil.url, 'anvil_impersonateAccount', [args.operator]);
    await rpc(anvil.url, 'anvil_setBalance', [args.operator, '0x56bc75e2d63100000']);
    const forkWallet = createWalletClient({
      account: { address: args.operator, type: 'json-rpc' },
      chain: sepolia,
      transport: http(anvil.url)
    });
    const send = async (tx) => {
      const hash = await forkWallet.sendTransaction({ to: tx.to, data: tx.data });
      const receipt = await forkClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`reverted: ${tx.title}`);
      return receipt;
    };
    rehearsed = await runSetup({
      publicClient: forkClient,
      send,
      operator: args.operator,
      parentLabel: args.parentLabel
    });
    await verify(forkClient, args.parentLabel, args.operator, rehearsed);
    console.log('  OK     rehearsal verified');
  } finally {
    anvil.child.kill();
  }

  if (!args.send) {
    printPlan(rehearsed.txs, args.parentLabel);
    return;
  }

  // ---- broadcast
  console.log('\nBroadcasting to Sepolia');
  const publicClient = createPublicClient({ chain: sepolia, transport: http(args.rpcUrl) });
  const wallet = createWalletClient({ account: liveAccount, chain: sepolia, transport: http(args.rpcUrl) });
  const send = async (tx) => {
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data });
    console.log(`  tx     ${hash}  (${tx.title})`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`reverted: ${tx.title} (${hash})`);
    return receipt;
  };
  const live = await runSetup({
    publicClient,
    send,
    operator: args.operator,
    parentLabel: args.parentLabel
  });
  await verify(publicClient, args.parentLabel, args.operator, live);

  console.log('\nDone. Put these in .env:');
  console.log(`  ENS_RESOLVER_ADDRESS=${live.resolverAddress}`);
  console.log(`  ENS_SUBNAME_REGISTRY_ADDRESS=${live.subRegistryAddress}`);
  if (live.resolverAddress.toLowerCase() !== rehearsed.resolverAddress.toLowerCase()) {
    console.log(
      `\nNOTE  the live resolver differs from the rehearsed one` +
        ` (${rehearsed.resolverAddress}) — live state moved between the two runs.`
    );
  }
}

main().catch((error) => {
  console.error(`\nsetup failed: ${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
