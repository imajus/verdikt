#!/usr/bin/env node
// Spike A — ENSv2 permissioned records on Sepolia (Tasks.md 0.2, Specification.md §4).
//
// WHAT THIS IS PROVING
//
// The SLA has no Arc-side copy (spec §3): the `sla` text record on
// `<slug>.verdikt.eth` IS the SLA. Two properties have to hold or that design
// collapses:
//
//   1. A text record round-trips byte-identical. If ENS mangles the JSON, the
//      enclave evaluates against something the provider did not publish.
//   2. Per-key writes are actually scoped. ENSv2 was chosen over v1 solely for
//      `authorizeTextRoles` (spec §4). If the provider can write `conformance`,
//      it can fake its own marketplace score, and v1's PublicResolver would
//      have been the simpler choice all along.
//
// So the negative assertions below carry the weight, not the positive ones.
// A write that *succeeds* where it should have reverted fails this spike.
//
// HOW IT RUNS
//
//   node scripts/spike-ens.mjs                # anvil fork of Sepolia (default)
//   node scripts/spike-ens.mjs --read-only    # no writes; checks live Sepolia state
//   node scripts/spike-ens.mjs --live         # real Sepolia, spends real testnet funds
//
// Fork mode is the default because it exercises the *real deployed ENSv2
// bytecode* — anvil forks Sepolia state — while needing no funded key and
// leaving no name registered. Every contract call below hits the same code a
// live run would. What fork mode cannot prove is that a live signer holds the
// funds and the parent name; `--live` covers that once those exist.

import { setTimeout as sleep } from 'node:timers/promises';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  namehash,
  parseEventLogs,
  stringToHex,
  toHex,
  zeroAddress
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { parseAbi } from 'viem';
import {
  ALL_ROLES,
  DEFAULT_SEPOLIA_RPC,
  RESOLVER_ROLES_VERDIKT_NEEDS,
  RESOLVER_ROLE_SET_TEXT,
  SEPOLIA_ENSV2,
  dnsEncode,
  factoryAbi,
  proxySalt,
  readNameState,
  registryAbi,
  resolverAbi,
  rpc,
  startAnvil,
  universalResolverAbi
} from './ens-sepolia.mjs';
import { SEPOLIA } from '@verdikt/sdk/deployments';

// Only this script registers a name, reads through the Universal Resolver, or
// touches MockUSDC, so these stay here rather than in the shared module.

const registrarAbi = parseAbi([
  'function isAvailable(string label) view returns (bool)',
  'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) view returns (bytes32)',
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)',
  'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256, uint256)',
  'function MIN_COMMITMENT_AGE() view returns (uint64)'
]);

const erc20Abi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)'
]);

/** PermissionedRegistry ROLE_SET_RESOLVER. Deliberately NOT granted to providers. */
const REGISTRY_ROLE_SET_RESOLVER = 1n << 24n;
/** PermissionedRegistry ROLE_SET_SUBREGISTRY. */
const REGISTRY_ROLE_SET_SUBREGISTRY = 1n << 20n;

const ONE_YEAR = 31_536_000n;

// The SLA the provider publishes. Deliberately hostile to a naive string
// round-trip: non-ASCII, an embedded newline, a quote, and a backslash. If
// ENS returns anything but this byte-for-byte, `evaluate` would be judging a
// different document than the one the provider signed up to.
const SLA_FIXTURE = JSON.stringify({
  version: 1,
  clauses: [
    { id: 'latency', type: 'latency', maxMs: 2000 },
    { id: 'price', type: 'priceRange', minMinor: '1000', maxMinor: '5000' },
    { id: 'schema', type: 'schema', note: 'ünïcødé — "quoted"\\backslash\nnewline' }
  ]
});

// --------------------------------------------------------------------------
// Tiny check harness. Every assertion is a named line in the output so a
// partial failure says exactly which property broke.

const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.log(`  FAIL  ${name}\n        ${error.message.split('\n')[0]}`);
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Assert that a write reverts *for the right reason*. A plain "it reverted"
 * is not evidence of access control — out-of-gas, a bad selector, or a
 * paused contract all revert too. Only `EACUnauthorizedAccountRoles` shows the
 * EAC check is what stopped it.
 */
async function expectEacRevert(promise, what) {
  let threw = false;
  try {
    await promise;
  } catch (error) {
    threw = true;
    const text = `${error.shortMessage ?? ''} ${error.metaMessages?.join(' ') ?? ''} ${error.message}`;
    assert(
      text.includes('EACUnauthorizedAccountRoles'),
      `${what} reverted, but not with EACUnauthorizedAccountRoles: ${error.shortMessage ?? error.message}`
    );
  }
  assert(threw, `${what} SUCCEEDED — the per-key ACL did not enforce`);
  return 'reverted with EACUnauthorizedAccountRoles';
}

const section = (title) => console.log(`\n${title}`);


// Fork-mode signers.
//
// NOT anvil's default mnemonic accounts. Those addresses are so widely used on
// public testnets that on Sepolia they already carry EIP-7702 delegation code,
// which makes `to.code.length > 0` true and the registry's ERC-1155 mint revert
// with ERC1155InvalidReceiver. Deriving keys from a Verdikt-specific string
// keeps runs deterministic while landing on addresses nobody has touched;
// stage 1's signer check fails loudly if that ever stops being true.
const forkKey = (role) => keccak256(stringToHex(`verdikt-spike-ens:${role}`));
const FORK_ROLES = ['deployer', 'provider', 'verifier', 'stranger'];

// --------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const valueOf = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    live: flags.has('--live'),
    readOnly: flags.has('--read-only'),
    parentLabel: valueOf('parent', SEPOLIA.ens.parentName.replace(/\.eth$/, '')),
    slug: valueOf('slug', 'weather'),
    rpcUrl: valueOf('rpc', process.env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.readOnly ? 'read-only' : args.live ? 'live' : 'fork';

  console.log('Spike A — ENSv2 permissioned records on Sepolia');
  console.log(`  mode        ${mode}`);
  console.log(`  upstream    ${args.rpcUrl}`);

  let anvil = null;
  let rpcUrl = args.rpcUrl;
  let accounts;

  if (mode === 'fork') {
    anvil = await startAnvil(args.rpcUrl);
    rpcUrl = anvil.url;
    accounts = FORK_ROLES.map((role) => privateKeyToAccount(forkKey(role)));
    console.log(`  fork        ${rpcUrl}`);
  } else if (mode === 'live') {
    const keys = [
      process.env.ENS_DEPLOYER_PRIVATE_KEY,
      process.env.PROVIDER_PRIVATE_KEY,
      process.env.ENS_SCORE_SIGNER_PRIVATE_KEY
    ];
    if (keys.some((k) => !k)) {
      throw new Error(
        '--live needs ENS_DEPLOYER_PRIVATE_KEY, PROVIDER_PRIVATE_KEY and ENS_SCORE_SIGNER_PRIVATE_KEY'
      );
    }
    accounts = [...keys.map((k) => privateKeyToAccount(k)), privateKeyToAccount(forkKey('stranger'))];
  }

  let [deployer] = accounts ?? [];
  const [, provider, verifier, stranger] = accounts ?? [];
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const walletFor = (account) => createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });

  const send = async (account, params) => {
    const { request } = await publicClient.simulateContract({ account, ...params });
    const hash = await walletFor(account).writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert(receipt.status === 'success', `transaction reverted: ${hash}`);
    return receipt;
  };

  try {
    // ---------------------------------------------------------------- stage 1
    section('1. Deployment discovery — are the ENSv2 contracts really there?');

    await check('chain is Sepolia (11155111)', async () => {
      const id = await publicClient.getChainId();
      assert(id === sepolia.id, `got chain id ${id}`);
      return `block ${await publicClient.getBlockNumber()}`;
    });

    if (mode === 'fork') {
      await check('fork signers are plain EOAs with funded balances', async () => {
        for (const account of accounts) {
          // A signer carrying code (an EIP-7702 delegation, say) fails the
          // registry's ERC-1155 acceptance check and the whole run dies three
          // stages later with an unrelated-looking error. Catch it here.
          const code = (await publicClient.getCode({ address: account.address })) ?? '0x';
          if (code !== '0x') {
            throw new Error(
              `${account.address} carries code (${code.slice(0, 12)}…) — pick different fork keys`
            );
          }
          await rpc(rpcUrl, 'anvil_setBalance', [account.address, toHex(10n ** 20n)]);
        }
        return accounts.map((a) => a.address).join(' ');
      });
    }

    for (const [name, address] of Object.entries(SEPOLIA_ENSV2)) {
      await check(`${name} has code`, async () => {
        const code = await publicClient.getCode({ address });
        assert(code && code !== '0x', `no code at ${address}`);
        return `${address} (${(code.length - 2) / 2} bytes)`;
      });
    }

    // ---------------------------------------------------------------- stage 2
    section(`2. Parent name — what state is "${args.parentLabel}.eth" in?`);

    const parentLabel = args.parentLabel;
    let parentStatus;
    let parentOwner;
    let parentTokenId;

    await check(`ETHRegistry state of "${parentLabel}"`, async () => {
      const state = await readNameState(publicClient, SEPOLIA_ENSV2.ETHRegistry, parentLabel);
      parentStatus = state.status;
      parentOwner = state.latestOwner;
      parentTokenId = state.tokenId;
      const expiry = state.expiry;
      const subregistry = await publicClient.readContract({
        address: SEPOLIA_ENSV2.ETHRegistry,
        abi: registryAbi,
        functionName: 'getSubregistry',
        args: [parentLabel]
      });
      const suffix =
        parentStatus === 'AVAILABLE'
          ? ''
          : `, owner ${parentOwner}, expiry ${expiry}, subregistry ${
              subregistry === zeroAddress ? 'NOT SET' : subregistry
            }`;
      return `${parentStatus}${suffix}`;
    });

    if (mode === 'read-only') {
      console.log('\n  (read-only: stopping before any write)');
      return;
    }

    // RESERVED means premigration holds the name and only an account with
    // ROLE_REGISTER_RESERVED on the ETHRegistry root — the migration
    // controllers — can promote it. Nothing this spike can route around.
    assert(
      parentStatus !== 'RESERVED',
      `"${parentLabel}.eth" is RESERVED on Sepolia ENSv2; it can only be claimed through a migration controller. Pass --parent <label>.`
    );

    const parentName = `${parentLabel}.eth`;
    const serviceName = `${args.slug}.${parentName}`;
    const serviceNode = namehash(serviceName);
    const serviceDnsName = dnsEncode(serviceName);

    // ---------------------------------------------------------------- stage 3
    section(`3. Take ownership of "${parentName}" and wire up a subname registry`);

    if (parentStatus === 'REGISTERED') {
      // The parent already exists. Registering a throwaway label instead would
      // test a name nobody uses, so run against the real one: on a fork,
      // impersonate its owner; live, that owner has to be the deployer key.
      if (mode === 'fork') {
        await check(`impersonating ${parentName}'s owner`, async () => {
          await rpc(rpcUrl, 'anvil_impersonateAccount', [parentOwner]);
          await rpc(rpcUrl, 'anvil_setBalance', [parentOwner, toHex(10n ** 20n)]);
          deployer = { address: parentOwner, type: 'json-rpc' };
          return parentOwner;
        });
      } else {
        assert(
          parentOwner.toLowerCase() === deployer.address.toLowerCase(),
          `${parentName} is owned by ${parentOwner}, not the deployer key ${deployer.address}`
        );
      }
    }

    await check(`${parentName} is owned by the deployer`, async () => {
      if (parentStatus === 'REGISTERED') {
        return `already registered to ${deployer.address}`;
      }
      const duration = ONE_YEAR;
      const [base, premium] = await publicClient.readContract({
        address: SEPOLIA_ENSV2.ETHRegistrar,
        abi: registrarAbi,
        functionName: 'getRegisterPrice',
        args: [parentLabel, duration, SEPOLIA_ENSV2.MockUSDC]
      });
      const price = base + premium;

      if (mode === 'fork') {
        // MockUSDC exposes a permissionless mint on Sepolia — the testnet's own
        // faucet mechanism, not a cheat code, so --live works the same way once
        // the deployer holds a balance.
        await send(deployer, {
          address: SEPOLIA_ENSV2.MockUSDC,
          abi: erc20Abi,
          functionName: 'mint',
          args: [deployer.address, price * 2n]
        });
      }
      await send(deployer, {
        address: SEPOLIA_ENSV2.MockUSDC,
        abi: erc20Abi,
        functionName: 'approve',
        args: [SEPOLIA_ENSV2.ETHRegistrar, price * 2n]
      });

      const secret = keccak256(stringToHex(`verdikt-spike-${parentLabel}`));
      const commitment = await publicClient.readContract({
        address: SEPOLIA_ENSV2.ETHRegistrar,
        abi: registrarAbi,
        functionName: 'makeCommitment',
        args: [parentLabel, deployer.address, secret, zeroAddress, zeroAddress, duration, `0x${'00'.repeat(32)}`]
      });
      await send(deployer, {
        address: SEPOLIA_ENSV2.ETHRegistrar,
        abi: registrarAbi,
        functionName: 'commit',
        args: [commitment]
      });

      const minAge = await publicClient.readContract({
        address: SEPOLIA_ENSV2.ETHRegistrar,
        abi: registrarAbi,
        functionName: 'MIN_COMMITMENT_AGE'
      });
      await advanceTime(rpcUrl, mode, Number(minAge) + 30);

      await send(deployer, {
        address: SEPOLIA_ENSV2.ETHRegistrar,
        abi: registrarAbi,
        functionName: 'register',
        args: [
          parentLabel,
          deployer.address,
          secret,
          zeroAddress,
          zeroAddress,
          duration,
          SEPOLIA_ENSV2.MockUSDC,
          `0x${'00'.repeat(32)}`
        ]
      });

      // Re-read rather than reuse the pre-registration state: the token id only
      // exists now, and it is what every later registry setter is keyed on.
      const registered = await readNameState(
        publicClient,
        SEPOLIA_ENSV2.ETHRegistry,
        parentLabel
      );
      parentTokenId = registered.tokenId;
      const owner = registered.latestOwner;
      assert(owner.toLowerCase() === deployer.address.toLowerCase(), `owner is ${owner}`);
      return `registered to ${owner} for ${Number(price) / 1e6} USDC`;
    });

    // Both proxies are deployed at a CREATE2 address derived from a fixed salt
    // scheme, so a second deployProxy with the same salt reverts on collision.
    // Reuse whatever the parent already points at — a name that has been set up
    // before is the normal case, not an error.
    const deployProxy = async (implementation, salt, data) => {
      const receipt = await send(deployer, {
        address: SEPOLIA_ENSV2.VerifiableFactory,
        abi: factoryAbi,
        functionName: 'deployProxy',
        args: [implementation, salt, data]
      });
      const [log] = parseEventLogs({ abi: factoryAbi, eventName: 'ProxyDeployed', logs: receipt.logs });
      assert(log?.args.proxyAddress, 'no proxy address in ProxyDeployed');
      return log.args.proxyAddress;
    };

    let resolverAddress;
    await check('PermissionedResolver proxy for the deployer', async () => {
      const existing = await publicClient.readContract({
        address: SEPOLIA_ENSV2.ETHRegistry,
        abi: registryAbi,
        functionName: 'getResolver',
        args: [parentLabel]
      });
      if (existing !== zeroAddress) {
        // Trust it only if the factory vouches for its provenance and
        // implementation — an arbitrary resolver would make every EAC
        // assertion below meaningless.
        const impl = await publicClient.readContract({
          address: SEPOLIA_ENSV2.VerifiableFactory,
          abi: factoryAbi,
          functionName: 'verifyContract',
          args: [existing]
        });
        assert(
          impl.toLowerCase() === SEPOLIA_ENSV2.PermissionedResolverImpl,
          `${existing} is not a factory-deployed PermissionedResolver (impl ${impl})`
        );
        // ...and only if the deployer can actually operate it. Resolvers are
        // per-account, so a name that changed hands still points at the *old*
        // holder's resolver: the new owner holds the name but none of the
        // resolver's root roles. Reusing it in that state fails every write
        // below with an error that looks like the ACL is broken.
        const operable = await publicClient.readContract({
          address: existing,
          abi: resolverAbi,
          functionName: 'hasRootRoles',
          args: [RESOLVER_ROLES_VERDIKT_NEEDS, deployer.address]
        });
        if (operable) {
          resolverAddress = existing;
          return `reusing ${existing}`;
        }
        console.log(
          `  NOTE  ${existing} is attached to ${parentName} but ${deployer.address}` +
            ' holds none of its root roles — deploying the deployer\'s own resolver'
        );
      }
      resolverAddress = await deployProxy(
        SEPOLIA_ENSV2.PermissionedResolverImpl,
        proxySalt('OwnedResolver', 'address', deployer.address),
        encodeFunctionData({
          abi: resolverAbi,
          functionName: 'initialize',
          args: [deployer.address, ALL_ROLES, []]
        })
      );
      return `deployed ${resolverAddress}`;
    });

    await check('the deployer holds the resolver roles Verdikt operates on', async () => {
      const operable = await publicClient.readContract({
        address: resolverAddress,
        abi: resolverAbi,
        functionName: 'hasRootRoles',
        args: [RESOLVER_ROLES_VERDIKT_NEEDS, deployer.address]
      });
      assert(
        operable,
        `${deployer.address} lacks ROLE_SET_ADDR / ROLE_SET_TEXT / ROLE_SET_TEXT_ADMIN on ${resolverAddress}`
      );
      return `${deployer.address} on ${resolverAddress}`;
    });

    let subRegistryAddress;
    await check(`UserRegistry proxy for ${parentName}`, async () => {
      const existing = await publicClient.readContract({
        address: SEPOLIA_ENSV2.ETHRegistry,
        abi: registryAbi,
        functionName: 'getSubregistry',
        args: [parentLabel]
      });
      if (existing !== zeroAddress) {
        subRegistryAddress = existing;
        return `reusing ${existing}`;
      }
      subRegistryAddress = await deployProxy(
        SEPOLIA_ENSV2.UserRegistryImpl,
        proxySalt('UserRegistry', 'bytes32', namehash(parentName)),
        encodeFunctionData({
          abi: registryAbi,
          functionName: 'initialize',
          args: [deployer.address, ALL_ROLES]
        })
      );
      return `deployed ${subRegistryAddress}`;
    });

    await check(`${parentName} points at the subname registry and the resolver`, async () => {
      await send(deployer, {
        address: SEPOLIA_ENSV2.ETHRegistry,
        abi: registryAbi,
        functionName: 'setSubregistry',
        args: [parentTokenId, subRegistryAddress]
      });
      await send(deployer, {
        address: SEPOLIA_ENSV2.ETHRegistry,
        abi: registryAbi,
        functionName: 'setResolver',
        args: [parentTokenId, resolverAddress]
      });
      // The backward pointer is what UniversalResolverV2 walks when it
      // reconstructs a canonical name; without it, subname resolution through
      // the hierarchy does not resolve.
      await send(deployer, {
        address: subRegistryAddress,
        abi: registryAbi,
        functionName: 'setParent',
        args: [SEPOLIA_ENSV2.ETHRegistry, parentLabel]
      });
      const wired = await publicClient.readContract({
        address: SEPOLIA_ENSV2.ETHRegistry,
        abi: registryAbi,
        functionName: 'getSubregistry',
        args: [parentLabel]
      });
      assert(wired.toLowerCase() === subRegistryAddress.toLowerCase(), `subregistry is ${wired}`);
      return `subregistry ${wired}`;
    });

    // ---------------------------------------------------------------- stage 4
    section(`4. Mint "${serviceName}" — the subname a provider registers under`);

    await check(`subname minted to the provider with NO ROLE_SET_RESOLVER`, async () => {
      // The role bitmap is the security boundary, not a formality. A provider
      // holding ROLE_SET_RESOLVER could repoint its own subname at a resolver
      // it fully controls and write `conformance` freely — the per-key ACL
      // proved below would be bypassed entirely. So the provider gets the
      // subname token and nothing else; Verdikt keeps resolver control.
      const providerRoles = 0n;
      assert(
        (providerRoles & (REGISTRY_ROLE_SET_RESOLVER | REGISTRY_ROLE_SET_SUBREGISTRY)) === 0n,
        'the provider bitmap must not include ROLE_SET_RESOLVER or ROLE_SET_SUBREGISTRY'
      );
      await send(deployer, {
        address: subRegistryAddress,
        abi: registryAbi,
        functionName: 'register',
        args: [
          args.slug,
          provider.address,
          zeroAddress,
          resolverAddress,
          providerRoles,
          BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 3600)
        ]
      });
      const minted = await readNameState(publicClient, subRegistryAddress, args.slug);
      assert(minted.status === 'REGISTERED', `subname status is ${minted.status}`);
      const owner = minted.latestOwner;
      assert(owner.toLowerCase() === provider.address.toLowerCase(), `owner is ${owner}`);
      return `owner ${owner}`;
    });

    await check('provider CANNOT repoint its own subname at another resolver', async () => {
      const { tokenId } = await readNameState(publicClient, subRegistryAddress, args.slug);
      return expectEacRevert(
        publicClient.simulateContract({
          account: provider,
          address: subRegistryAddress,
          abi: registryAbi,
          functionName: 'setResolver',
          args: [tokenId, provider.address]
        }),
        'provider setResolver on its own subname'
      );
    });

    await check('address record round-trips (the payTo check the proxy makes)', async () => {
      await send(deployer, {
        address: resolverAddress,
        abi: resolverAbi,
        functionName: 'setAddr',
        args: [serviceNode, provider.address]
      });
      const got = await publicClient.readContract({
        address: resolverAddress,
        abi: resolverAbi,
        functionName: 'addr',
        args: [serviceNode]
      });
      assert(got.toLowerCase() === provider.address.toLowerCase(), `addr is ${got}`);
      return got;
    });

    // ---------------------------------------------------------------- stage 5
    section('5. Per-key EAC — the reason ENSv2 was chosen over v1');

    await check('authorizeTextRoles scopes the provider to `sla`', async () => {
      await send(deployer, {
        address: resolverAddress,
        abi: resolverAbi,
        functionName: 'authorizeTextRoles',
        args: [serviceDnsName, 'sla', provider.address, true]
      });
      return `${provider.address} -> sla`;
    });

    await check('authorizeTextRoles scopes the verifier to `conformance` + `availability`', async () => {
      for (const key of ['conformance', 'availability']) {
        await send(deployer, {
          address: resolverAddress,
          abi: resolverAbi,
          functionName: 'authorizeTextRoles',
          args: [serviceDnsName, key, verifier.address, true]
        });
      }
      return `${verifier.address} -> conformance, availability`;
    });

    await check('provider writes `sla`; it reads back byte-identical', async () => {
      await send(provider, {
        address: resolverAddress,
        abi: resolverAbi,
        functionName: 'setText',
        args: [serviceNode, 'sla', SLA_FIXTURE]
      });
      const got = await publicClient.readContract({
        address: resolverAddress,
        abi: resolverAbi,
        functionName: 'text',
        args: [serviceNode, 'sla']
      });
      assert(got === SLA_FIXTURE, `round-trip mismatch:\n  wrote ${SLA_FIXTURE}\n  read  ${got}`);
      assert(JSON.parse(got).clauses.length === 3, 'parsed SLA lost clauses');
      return `${Buffer.byteLength(got)} bytes identical, incl. unicode/newline/quote/backslash`;
    });

    await check('NEGATIVE: provider scoped to `sla` cannot write `conformance`', () =>
      expectEacRevert(
        publicClient.simulateContract({
          account: provider,
          address: resolverAddress,
          abi: resolverAbi,
          functionName: 'setText',
          args: [serviceNode, 'conformance', '1000']
        }),
        'provider setText(conformance)'
      )
    );

    await check('NEGATIVE: provider scoped to `sla` cannot write `availability`', () =>
      expectEacRevert(
        publicClient.simulateContract({
          account: provider,
          address: resolverAddress,
          abi: resolverAbi,
          functionName: 'setText',
          args: [serviceNode, 'availability', '1000']
        }),
        'provider setText(availability)'
      )
    );

    await check('verifier writes `conformance` and `availability`', async () => {
      for (const [key, value] of [
        ['conformance', '987'],
        ['availability', '1000']
      ]) {
        await send(verifier, {
          address: resolverAddress,
          abi: resolverAbi,
          functionName: 'setText',
          args: [serviceNode, key, value]
        });
      }
      const conformance = await publicClient.readContract({
        address: resolverAddress,
        abi: resolverAbi,
        functionName: 'text',
        args: [serviceNode, 'conformance']
      });
      assert(conformance === '987', `conformance is ${conformance}`);
      return 'conformance=987 availability=1000';
    });

    await check('NEGATIVE: verifier scoped to the ratios cannot write `sla`', () =>
      expectEacRevert(
        publicClient.simulateContract({
          account: verifier,
          address: resolverAddress,
          abi: resolverAbi,
          functionName: 'setText',
          args: [serviceNode, 'sla', '{"version":1,"clauses":[]}']
        }),
        'verifier setText(sla)'
      )
    );

    await check('NEGATIVE: the subname owner alone cannot write an unauthorized key', () =>
      expectEacRevert(
        publicClient.simulateContract({
          account: provider,
          address: resolverAddress,
          abi: resolverAbi,
          functionName: 'setText',
          args: [serviceNode, 'avatar', 'https://example.invalid/a.png']
        }),
        'provider setText(avatar)'
      )
    );

    await check('NEGATIVE: an unrelated address cannot write `sla`', () =>
      expectEacRevert(
        publicClient.simulateContract({
          account: stranger,
          address: resolverAddress,
          abi: resolverAbi,
          functionName: 'setText',
          args: [serviceNode, 'sla', '{}']
        }),
        'stranger setText(sla)'
      )
    );

    await check('name-level ROLE_SET_TEXT is a superset — why Verdikt must not grant it', async () => {
      // `authorizeNameRoles(name, ROLE_SET_TEXT, ...)` covers *every* text key
      // on the name, so granting it to a provider hands them `conformance`.
      // Proving that here fixes the seam: @verdikt/sdk must only ever call
      // authorizeTextRoles, never authorizeNameRoles, for provider grants.
      await send(deployer, {
        address: resolverAddress,
        abi: resolverAbi,
        functionName: 'authorizeNameRoles',
        args: [serviceDnsName, RESOLVER_ROLE_SET_TEXT, provider.address, true]
      });
      await send(provider, {
        address: resolverAddress,
        abi: resolverAbi,
        functionName: 'setText',
        args: [serviceNode, 'conformance', '1']
      });
      const forged = await publicClient.readContract({
        address: resolverAddress,
        abi: resolverAbi,
        functionName: 'text',
        args: [serviceNode, 'conformance']
      });
      assert(forged === '1', `expected the forged write to land, got ${forged}`);

      // Put the world back: revoke, restore the real ratio, and re-assert the
      // scoped denial so the run does not end with a provider able to lie.
      await send(deployer, {
        address: resolverAddress,
        abi: resolverAbi,
        functionName: 'authorizeNameRoles',
        args: [serviceDnsName, RESOLVER_ROLE_SET_TEXT, provider.address, false]
      });
      await send(verifier, {
        address: resolverAddress,
        abi: resolverAbi,
        functionName: 'setText',
        args: [serviceNode, 'conformance', '987']
      });
      await expectEacRevert(
        publicClient.simulateContract({
          account: provider,
          address: resolverAddress,
          abi: resolverAbi,
          functionName: 'setText',
          args: [serviceNode, 'conformance', '1']
        }),
        'provider setText(conformance) after revoke'
      );
      return 'provider forged conformance under a name-level grant; denied again after revoke';
    });

    // ---------------------------------------------------------------- stage 6
    section('6. Read path — resolve through UniversalResolverV2, as consumers will');

    await check('UniversalResolverV2 resolves all four records of the ServiceRecord', async () => {
      // This is the call shape `resolveServiceRecord` will make: one name, four
      // record reads, resolved by walking the registry hierarchy rather than by
      // knowing the resolver address. If this works, no consumer of
      // @verdikt/sdk/ens needs to know a subregistry exists.
      const read = async (fn, fnArgs) => {
        const [result] = await publicClient.readContract({
          address: SEPOLIA_ENSV2.UniversalResolverV2,
          abi: universalResolverAbi,
          functionName: 'resolve',
          args: [serviceDnsName, encodeFunctionData({ abi: resolverAbi, functionName: fn, args: fnArgs })]
        });
        return result;
      };

      const addrRaw = await read('addr', [serviceNode]);
      const resolvedAddr = `0x${addrRaw.slice(-40)}`;
      assert(
        resolvedAddr.toLowerCase() === provider.address.toLowerCase(),
        `addr resolved to ${resolvedAddr}`
      );

      const sla = decodeString(await read('text', [serviceNode, 'sla']));
      assert(sla === SLA_FIXTURE, 'sla differs when read through the Universal Resolver');

      const conformance = decodeString(await read('text', [serviceNode, 'conformance']));
      assert(conformance === '987', `conformance is ${conformance}`);

      const availability = decodeString(await read('text', [serviceNode, 'availability']));
      assert(availability === '1000', `availability is ${availability}`);

      // A key that was never written must come back empty, not revert — the
      // `null`-not-throw contract ServiceRecord depends on.
      const unwritten = decodeString(await read('text', [serviceNode, 'description']));
      assert(unwritten === '', `unwritten key returned ${JSON.stringify(unwritten)}`);

      return 'addr + sla + conformance + availability; unwritten key resolves empty';
    });
  } finally {
    finish(anvil);
  }
}

function decodeString(hex) {
  // ABI-decode a single dynamic string without pulling in a decoder: offset,
  // length, then the bytes.
  const body = hex.slice(2);
  const length = parseInt(body.slice(64, 128), 16);
  return Buffer.from(body.slice(128, 128 + length * 2), 'hex').toString('utf8');
}

async function advanceTime(rpcUrl, mode, seconds) {
  if (mode === 'fork') {
    await rpc(rpcUrl, 'evm_increaseTime', [seconds]);
    await rpc(rpcUrl, 'evm_mine', []);
    return;
  }
  // Live Sepolia has no time machine: the commit-reveal window is real.
  await sleep((seconds + 5) * 1000);
}

function finish(anvil) {
  anvil?.child.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? `\nFAILED: ${failed.map((r) => r.name).join('; ')}` : '')
  );
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(`\nspike aborted: ${error.message}`);
  process.exitCode = 1;
});
