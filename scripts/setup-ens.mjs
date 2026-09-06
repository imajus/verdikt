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
// That includes dying between a deployProxy and the pointer write after it: the
// orphaned proxy is found at its predicted CREATE2 address and reused, since a
// second deployProxy with the same salt can only revert.
//
// HOW IT RUNS
//
//   node scripts/setup-ens.mjs           # plan: dry-run on a fork, write calldata
//   node scripts/setup-ens.mjs --send    # broadcast to Sepolia
//
// The plan is written to `ens-setup-plan.json` (--out to change it) and shown
// abbreviated in the terminal, because a 300-byte hex string copied out of a
// terminal can be clipped into something that still looks like valid calldata.
// --full prints it in full anyway.
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

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  http,
  keccak256,
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
  anyId,
  readNameState,
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
    full: argv.includes('--full'),
    parentLabel: valueOf('parent', (process.env.ENS_PARENT_NAME ?? 'verdikt.eth').replace(/\.eth$/, '')),
    operator: valueOf('operator', process.env.ENS_OPERATOR_ADDRESS),
    out: valueOf('out', 'ens-setup-plan.json'),
    rpcUrl: valueOf('rpc', process.env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC)
  };
}

/**
 * Read the current state of the parent name. Everything the plan branches on
 * comes from here, so a re-run after a partial setup sees what actually landed.
 */
async function readState(publicClient, parentLabel, operator) {
  const [name, resolver, subregistry] = await Promise.all([
    readNameState(publicClient, SEPOLIA_ENSV2.ETHRegistry, parentLabel),
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

  return {
    status: name.status,
    owner: name.latestOwner,
    expiry: name.expiry,
    resolver,
    subregistry,
    resolverOperable
  };
}

/**
 * The address a VerifiableFactory deployProxy call from `operator` will land
 * on, computed offline. From the factory's verified source: the CREATE2 salt
 * is keccak256(abi.encode(msg.sender, salt)), and the creation code is the
 * EIP-1167 clone stub around the shared `proxyLogic` address with that salt
 * appended for extcodecopy. The factory is immutable at its pinned address,
 * so neither constant can drift for it.
 */
function predictProxyAddress(proxyLogic, operator, salt) {
  const outerSalt = keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [operator, salt])
  );
  return getContractAddress({
    opcode: 'CREATE2',
    from: SEPOLIA_ENSV2.VerifiableFactory,
    salt: outerSalt,
    bytecode: concatHex([
      '0x3d604d80600a3d3981f3363d3d373d3d3d363d73',
      proxyLogic,
      '0x5af43d82803e903d91602b57fd5bf3',
      outerSalt
    ])
  });
}

/**
 * Deploy a proxy through the VerifiableFactory — or reuse the one a previous
 * partial run left behind. Each setup step is two transactions (deployProxy,
 * then the pointer write), and the branch that decides whether to deploy only
 * sees the pointer. A run that died between the two leaves a proxy no pointer
 * knows about, and redeploying with the same deterministic salt reverts on the
 * CREATE2 collision — forever, wedging the script. So look for code at the
 * predicted address first, and have the factory itself vouch for what is there
 * before trusting it. deployProxy initializes atomically, so a recovered proxy
 * is never half-set-up; only its pointer write is missing.
 */
async function deployProxyOrReuse({ publicClient, send, operator, txs }, { title, label, implementation, salt, initData }) {
  const proxyLogic = await publicClient.readContract({
    address: SEPOLIA_ENSV2.VerifiableFactory,
    abi: factoryAbi,
    functionName: 'proxyLogic'
  });
  const predicted = predictProxyAddress(proxyLogic, operator, salt);
  const code = await publicClient.getCode({ address: predicted });
  if (code && code !== '0x') {
    const impl = await publicClient.readContract({
      address: SEPOLIA_ENSV2.VerifiableFactory,
      abi: factoryAbi,
      functionName: 'verifyContract',
      args: [predicted]
    });
    if (impl.toLowerCase() !== implementation) {
      throw new Error(`${predicted} was deployed with this salt but implements ${impl}, not ${implementation}`);
    }
    console.log(`  reuse  ${label} ${predicted} — deployed by an earlier run, never pointed at`);
    return predicted;
  }
  const tx = {
    title,
    to: SEPOLIA_ENSV2.VerifiableFactory,
    data: encodeFunctionData({
      abi: factoryAbi,
      functionName: 'deployProxy',
      args: [implementation, salt, initData]
    })
  };
  const receipt = await send(tx);
  const [log] = parseEventLogs({ abi: factoryAbi, eventName: 'ProxyDeployed', logs: receipt.logs });
  txs.push({ ...tx, result: log.args.proxyAddress });
  console.log(`  done   ${label} ${log.args.proxyAddress}`);
  return log.args.proxyAddress;
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
    resolverAddress = await deployProxyOrReuse(
      { publicClient, send, operator, txs },
      {
        title: 'deploy the operator\'s PermissionedResolver',
        label: 'resolver',
        implementation: SEPOLIA_ENSV2.PermissionedResolverImpl,
        salt: proxySalt('OwnedResolver', 'address', operator),
        initData: encodeFunctionData({
          abi: resolverAbi,
          functionName: 'initialize',
          args: [operator, ALL_ROLES, []]
        })
      }
    );
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
    subRegistryAddress = await deployProxyOrReuse(
      { publicClient, send, operator, txs },
      {
        title: `deploy the UserRegistry for ${parentName}`,
        label: 'subregistry',
        implementation: SEPOLIA_ENSV2.UserRegistryImpl,
        salt: proxySalt('UserRegistry', 'bytes32', namehash(parentName)),
        initData: encodeFunctionData({
          abi: registryAbi,
          functionName: 'initialize',
          args: [operator, ALL_ROLES]
        })
      }
    );
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

/**
 * Calldata is written to a file, and shown abbreviated with its byte length.
 *
 * Printing 300 bytes of hex invites copying it out of a terminal, and a
 * terminal is exactly where a long unbroken token gets clipped — silently, into
 * something that is still a valid hex string and still a correct *prefix* of
 * the real one. Signing that is unrecoverable. The byte count makes a short
 * copy obvious; the JSON file makes copying unnecessary.
 */
function abbreviate(data, full) {
  const bytes = (data.length - 2) / 2;
  if (full || data.length <= 46) return `${data}  (${bytes} bytes)`;
  return `${data.slice(0, 34)}…${data.slice(-8)}  (${bytes} bytes — full value in the plan file)`;
}

function printPlan(txs, { parentLabel, operator, outPath, full }) {
  if (!txs.length) {
    console.log('\nNothing to do — the namespace is already set up.');
    return;
  }

  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        chainId: sepolia.id,
        parent: `${parentLabel}.eth`,
        operator,
        generatedAt: new Date().toISOString(),
        transactions: txs.map((tx, i) => ({
          step: i + 1,
          title: tx.title,
          to: tx.to,
          value: '0x0',
          data: tx.data,
          ...(tx.result ? { deploys: tx.result } : {})
        }))
      },
      null,
      2
    )}\n`
  );

  console.log(`\nTransactions to sign, in order, from ${operator}:\n`);
  txs.forEach((tx, i) => {
    console.log(`  ${i + 1}. ${tx.title}`);
    console.log(`     to    ${tx.to}`);
    console.log(`     value 0`);
    console.log(`     data  ${abbreviate(tx.data, full)}`);
    if (tx.result) console.log(`     ->    deploys ${tx.result}`);
    console.log();
  });
  console.log(
    `Full calldata: ${outPath}\n` +
      `Take it from that file, not from this terminal — a long hex string wraps and\n` +
      `clips, and a truncated copy is still valid-looking hex. (--full prints it here.)\n\n` +
      `Addresses above are what a live run will produce: a VerifiableFactory proxy\n` +
      `address is fixed by (factory, sender, salt), so the fork predicts it exactly.\n` +
      `Sign these from any wallet, or run with --send and skip the copying entirely.\n\n` +
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
    printPlan(rehearsed.txs, {
      parentLabel: args.parentLabel,
      operator: args.operator,
      outPath: resolve(args.out),
      full: args.full
    });
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
