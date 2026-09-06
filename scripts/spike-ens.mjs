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

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  namehash,
  parseAbi,
  parseEventLogs,
  stringToHex,
  toHex,
  zeroAddress
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { packetToBytes } from 'viem/ens';
import { sepolia } from 'viem/chains';

// --------------------------------------------------------------------------
// Deployment addresses — ENSv2 Beta on Sepolia.
//
// Source: docs.ens.domains/learn/deployments, which renders
// ensdomains/contracts-v2 `contracts/deployments/sepolia/*.json`. Stage 1
// asserts each has code rather than trusting the list: a beta deployment can be
// redeployed, and a silently-wrong address would make every later check
// vacuous.
const SEPOLIA_ENSV2 = Object.freeze({
  ETHRegistry: '0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2',
  ETHRegistrar: '0xa88553f454b77203b0d036a05c894d555eaaa2cc',
  RootRegistry: '0x8115186e8f2e0b0281e86ab91f0f48ba90364354',
  UniversalResolverV2: '0x4a1817d13e9cf196f471725176355c1234b63c70',
  VerifiableFactory: '0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef',
  PermissionedResolverImpl: '0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e',
  UserRegistryImpl: '0x624a25d67b59d587752ebec8dded8827dae52050',
  MockUSDC: '0x768f42455a2d082e23ceef7d51e5787c82d67a39'
});

const DEFAULT_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

// --------------------------------------------------------------------------
// ABIs. Human-readable fragments rather than committed artifacts: the full
// deployment JSONs are ~2MB each and this spike touches a dozen functions.
// Every fragment here was taken from the deployed artifact, not from the docs.

const registryAbi = parseAbi([
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function setResolver(uint256 anyId, address resolver)',
  'function setParent(address parent, string label)',
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
  'function getExpiry(uint256 anyId) view returns (uint64)',
  'function latestOwnerOf(uint256 tokenId) view returns (address)',
  'function findTokenId(string label) view returns (uint256)',
  'function initialize(address rootAccount, uint256 roleBitmap)',
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)'
]);

const registrarAbi = parseAbi([
  'function isAvailable(string label) view returns (bool)',
  'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) view returns (bytes32)',
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)',
  'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256, uint256)',
  'function MIN_COMMITMENT_AGE() view returns (uint64)'
]);

const resolverAbi = parseAbi([
  'function initialize(address admin, uint256 roleBitmap, bytes[] setters)',
  'function setText(bytes32 node, string key, string value)',
  'function text(bytes32 node, string key) view returns (string)',
  'function setAddr(bytes32 node, address addr_)',
  'function addr(bytes32 node) view returns (address)',
  'function authorizeTextRoles(bytes toName, string key, address account, bool grant) returns (bool)',
  'function authorizeNameRoles(bytes toName, uint256 roleBitmap, address account, bool grant) returns (bool)',
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)'
]);

const factoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address)',
  'event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)'
]);

const universalResolverAbi = parseAbi([
  'function resolve(bytes name, bytes data) view returns (bytes, address)'
]);

const erc20Abi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)'
]);

// --------------------------------------------------------------------------
// EAC roles. Values from the deployed contracts' documentation tables; the
// bitmaps are asserted against on-chain behaviour by the checks below, so a
// wrong constant here shows up as a failed check rather than a silent pass.

/** Every role and admin counterpart — what ENS's own tooling passes on init. */
const ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111n;
/** PermissionedRegistry ROLE_SET_RESOLVER. Deliberately NOT granted to providers. */
const REGISTRY_ROLE_SET_RESOLVER = 1n << 24n;
/** PermissionedRegistry ROLE_SET_SUBREGISTRY. */
const REGISTRY_ROLE_SET_SUBREGISTRY = 1n << 20n;
/** PermissionedResolver ROLE_SET_TEXT — name-level, i.e. every text key at once. */
const RESOLVER_ROLE_SET_TEXT = 1n << 4n;

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

// --------------------------------------------------------------------------
// Salt schemes for VerifiableFactory proxies. Both are fully determined by
// (kind, key), so a client can derive the same address the factory will use.

function proxySalt(kind, keyType, key, version = 0n) {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: keyType }, { type: 'uint256' }],
        [keccak256(stringToHex(kind)), key, version]
      )
    )
  );
}

const dnsEncode = (name) => toHex(packetToBytes(name));

// --------------------------------------------------------------------------
// anvil lifecycle (fork mode).

async function startAnvil(forkUrl) {
  const port = 8600 + Math.floor(Math.random() * 300);
  const child = spawn(
    'anvil',
    ['--fork-url', forkUrl, '--port', String(port), '--silent', '--chain-id', String(sepolia.id)],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });

  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`anvil exited (${child.exitCode}): ${stderr.slice(0, 400)}`);
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
      });
      if (res.ok) return { url, child };
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`anvil did not become ready: ${stderr.slice(0, 400)}`);
}

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
    parentLabel: valueOf('parent', (process.env.ENS_PARENT_NAME ?? 'verdikt.eth').replace(/\.eth$/, '')),
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
      process.env.VERIFIER_PRIVATE_KEY
    ];
    if (keys.some((k) => !k)) {
      throw new Error(
        '--live needs ENS_DEPLOYER_PRIVATE_KEY, PROVIDER_PRIVATE_KEY and VERIFIER_PRIVATE_KEY'
      );
    }
    accounts = [...keys.map((k) => privateKeyToAccount(k)), privateKeyToAccount(forkKey('stranger'))];
  }

  const [deployer, provider, verifier, stranger] = accounts ?? [];
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
    section(`2. Parent name — is "${args.parentLabel}.eth" registrable?`);

    let parentLabel = args.parentLabel;
    let parentAvailable = false;

    await check(`ETHRegistrar.isAvailable("${args.parentLabel}")`, async () => {
      parentAvailable = await publicClient.readContract({
        address: SEPOLIA_ENSV2.ETHRegistrar,
        abi: registrarAbi,
        functionName: 'isAvailable',
        args: [args.parentLabel]
      });
      if (parentAvailable) return 'available';
      const expiry = await publicClient.readContract({
        address: SEPOLIA_ENSV2.ETHRegistry,
        abi: registryAbi,
        functionName: 'getExpiry',
        args: [BigInt(keccak256(stringToHex(args.parentLabel)))]
      });
      const owner = await publicClient.readContract({
        address: SEPOLIA_ENSV2.ETHRegistry,
        abi: registryAbi,
        functionName: 'latestOwnerOf',
        args: [BigInt(keccak256(stringToHex(args.parentLabel)))]
      });
      // owner == 0 with a non-zero expiry is ENSv2's RESERVED state: the name
      // was reserved by premigration and only a migration controller (holding
      // ROLE_REGISTER_RESERVED) can promote it. Not a failure of this spike —
      // a fact the parent-name decision has to account for (Tasks.md 0.6).
      const state = owner === zeroAddress ? 'RESERVED (premigration)' : `REGISTERED to ${owner}`;
      return `NOT available — ${state}, expiry ${expiry}`;
    });

    if (mode === 'read-only') {
      console.log('\n  (read-only: stopping before any write)');
      return;
    }

    if (!parentAvailable) {
      if (mode === 'live') {
        throw new Error(
          `"${args.parentLabel}.eth" is not registrable on Sepolia ENSv2; pass --parent <label> or claim it first`
        );
      }
      parentLabel = `${args.parentLabel}-spike`;
      const fallbackFree = await publicClient.readContract({
        address: SEPOLIA_ENSV2.ETHRegistrar,
        abi: registrarAbi,
        functionName: 'isAvailable',
        args: [parentLabel]
      });
      assert(fallbackFree, `neither "${args.parentLabel}" nor "${parentLabel}" is available`);
      console.log(`  NOTE  falling back to "${parentLabel}.eth" for this run`);
    }

    const parentName = `${parentLabel}.eth`;
    const serviceName = `${args.slug}.${parentName}`;
    const serviceNode = namehash(serviceName);
    const serviceDnsName = dnsEncode(serviceName);

    // ---------------------------------------------------------------- stage 3
    section(`3. Register "${parentName}" and wire up a subname registry`);

    let parentTokenId;
    await check(`ETHRegistrar commit/reveal registers ${parentName}`, async () => {
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

      parentTokenId = await publicClient.readContract({
        address: SEPOLIA_ENSV2.ETHRegistry,
        abi: registryAbi,
        functionName: 'findTokenId',
        args: [parentLabel]
      });
      const owner = await publicClient.readContract({
        address: SEPOLIA_ENSV2.ETHRegistry,
        abi: registryAbi,
        functionName: 'latestOwnerOf',
        args: [parentTokenId]
      });
      assert(owner.toLowerCase() === deployer.address.toLowerCase(), `owner is ${owner}`);
      return `owner ${owner}, ${Number(price) / 1e6} USDC`;
    });

    let resolverAddress;
    await check('VerifiableFactory deploys a PermissionedResolver for the deployer', async () => {
      const salt = proxySalt('OwnedResolver', 'address', deployer.address);
      const data = encodeFunctionData({
        abi: resolverAbi,
        functionName: 'initialize',
        args: [deployer.address, ALL_ROLES, []]
      });
      const receipt = await send(deployer, {
        address: SEPOLIA_ENSV2.VerifiableFactory,
        abi: factoryAbi,
        functionName: 'deployProxy',
        args: [SEPOLIA_ENSV2.PermissionedResolverImpl, salt, data]
      });
      const [log] = parseEventLogs({ abi: factoryAbi, eventName: 'ProxyDeployed', logs: receipt.logs });
      resolverAddress = log.args.proxyAddress;
      assert(resolverAddress && resolverAddress !== zeroAddress, 'no proxy address in ProxyDeployed');
      return resolverAddress;
    });

    let subRegistryAddress;
    await check(`VerifiableFactory deploys a UserRegistry for ${parentName}`, async () => {
      const salt = proxySalt('UserRegistry', 'bytes32', namehash(parentName));
      const data = encodeFunctionData({
        abi: registryAbi,
        functionName: 'initialize',
        args: [deployer.address, ALL_ROLES]
      });
      const receipt = await send(deployer, {
        address: SEPOLIA_ENSV2.VerifiableFactory,
        abi: factoryAbi,
        functionName: 'deployProxy',
        args: [SEPOLIA_ENSV2.UserRegistryImpl, salt, data]
      });
      const [log] = parseEventLogs({ abi: factoryAbi, eventName: 'ProxyDeployed', logs: receipt.logs });
      subRegistryAddress = log.args.proxyAddress;
      assert(subRegistryAddress && subRegistryAddress !== zeroAddress, 'no proxy address in ProxyDeployed');
      return subRegistryAddress;
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
      const owner = await publicClient.readContract({
        address: subRegistryAddress,
        abi: registryAbi,
        functionName: 'latestOwnerOf',
        args: [
          await publicClient.readContract({
            address: subRegistryAddress,
            abi: registryAbi,
            functionName: 'findTokenId',
            args: [args.slug]
          })
        ]
      });
      assert(owner.toLowerCase() === provider.address.toLowerCase(), `owner is ${owner}`);
      return `owner ${owner}`;
    });

    await check('provider CANNOT repoint its own subname at another resolver', async () => {
      const tokenId = await publicClient.readContract({
        address: subRegistryAddress,
        abi: registryAbi,
        functionName: 'findTokenId',
        args: [args.slug]
      });
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

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
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
