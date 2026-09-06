// Shared ENSv2-on-Sepolia constants and helpers for the scripts in this
// directory (`spike-ens.mjs`, `setup-ens.mjs`).
//
// This is operational tooling, not application code. The rule that
// `packages/sdk/ens.js` is the only file that knows ENS exists holds for the
// proxy, the CRE workflows and the dashboard — the things that ship. These
// scripts talk to the registry and the factory, which the SDK deliberately
// never does, and they would otherwise duplicate every address and ABI
// fragment twice over and drift apart.
//
// WHAT BELONGS HERE
//
// Only what both scripts use, or what this file needs to define what they use.
// A constant one script needs stays in that script — a shared module that
// accumulates single-caller items stops being a seam and becomes a junk drawer,
// and the next reader can no longer tell which parts actually have to agree.
//
// THE READ PATH IS THE SDK'S (Tasks.md 4.5)
//
// The Universal Resolver address, the record ABI and DNS encoding live in
// `packages/sdk/ens.js` and are imported below, not copied. Two files knowing
// the ENSv2 deployment is exactly the duplication the choke-point rule exists
// to prevent, and an address that moves in the beta would otherwise have to be
// fixed twice. What stays here is the registrar, factory, EAC-onboarding and
// anvil surface, which the SDK must never carry.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { encodeAbiParameters, keccak256, parseAbi, stringToHex } from 'viem';
import { sepolia } from 'viem/chains';
import {
  DEFAULT_SEPOLIA_RPC as SDK_DEFAULT_SEPOLIA_RPC,
  SEPOLIA_UNIVERSAL_RESOLVER,
  resolverRecordsAbi
} from '@verdikt/sdk/ens';

export { dnsEncode, universalResolverAbi } from '@verdikt/sdk/ens';

// --------------------------------------------------------------------------
// Deployment addresses — ENSv2 Beta on Sepolia.
//
// Source: docs.ens.domains/learn/deployments, which renders
// ensdomains/contracts-v2 `contracts/deployments/sepolia/*.json`. Both scripts
// assert each has code rather than trusting the list: a beta deployment can be
// redeployed, and a silently-wrong address would make every later check vacuous.
export const SEPOLIA_ENSV2 = Object.freeze({
  ETHRegistry: '0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2',
  ETHRegistrar: '0xa88553f454b77203b0d036a05c894d555eaaa2cc',
  RootRegistry: '0x8115186e8f2e0b0281e86ab91f0f48ba90364354',
  // The one address the SDK also needs, so the SDK owns it.
  UniversalResolverV2: SEPOLIA_UNIVERSAL_RESOLVER,
  VerifiableFactory: '0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef',
  PermissionedResolverImpl: '0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e',
  UserRegistryImpl: '0x624a25d67b59d587752ebec8dded8827dae52050',
  MockUSDC: '0x768f42455a2d082e23ceef7d51e5787c82d67a39'
});

export const DEFAULT_SEPOLIA_RPC = SDK_DEFAULT_SEPOLIA_RPC;

// --------------------------------------------------------------------------
// ABIs. Human-readable fragments rather than committed artifacts: the full
// deployment JSONs are ~2MB each and these scripts touch a dozen functions.
// Every fragment here was taken from the deployed artifact, not from the docs.

export const registryAbi = parseAbi([
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function setResolver(uint256 anyId, address resolver)',
  'function setParent(address parent, string label)',
  'function getParent() view returns (address, string)',
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
  'function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))',
  'function initialize(address rootAccount, uint256 roleBitmap)',
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)'
]);

/**
 * The record surface comes from the SDK; only the EAC/onboarding fragments are
 * added here. Nothing that ships needs `initialize` or `authorize*`, so
 * carrying them into `packages/sdk/ens.js` would make it the registrar it is
 * deliberately not.
 */
export const resolverAbi = [
  ...resolverRecordsAbi,
  ...parseAbi([
    'function initialize(address admin, uint256 roleBitmap, bytes[] setters)',
    'function authorizeTextRoles(bytes toName, string key, address account, bool grant) returns (bool)',
    'function authorizeNameRoles(bytes toName, uint256 roleBitmap, address account, bool grant) returns (bool)',
    'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
    'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)'
  ])
];

export const factoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address)',
  'function proxyLogic() view returns (address)',
  'function verifyContract(address proxy) view returns (address)',
  'event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)'
]);

// --------------------------------------------------------------------------
// EAC roles. Values from the deployed contracts' documentation tables; both
// scripts assert them against on-chain behaviour, so a wrong constant here
// shows up as a failure rather than a silent pass.

/** Every role and admin counterpart — what ENS's own tooling passes on init. */
export const ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111n;
/**
 * PermissionedResolver ROLE_SET_TEXT — name-level, i.e. every text key at once.
 * Shared because `RESOLVER_ROLES_VERDIKT_NEEDS` below is derived from it.
 */
export const RESOLVER_ROLE_SET_TEXT = 1n << 4n;
/**
 * What Verdikt needs on a resolver's ROOT_RESOURCE to operate it: write the
 * address record, write text, and — the one that matters — the admin role that
 * lets it delegate individual text keys to providers and to the CRE signer.
 */
export const RESOLVER_ROLES_VERDIKT_NEEDS =
  (1n << 0n) | RESOLVER_ROLE_SET_TEXT | (RESOLVER_ROLE_SET_TEXT << 128n);

/**
 * `IPermissionedRegistry.Status`, indexed by `getState().status`.
 *
 * Read state with `getState`, never by inferring it from an owner lookup: a
 * name's token id is NOT its labelhash (the low 32 bits are a version counter
 * that changes on re-registration and role updates), so
 * `latestOwnerOf(labelhash)` returns the zero address for a perfectly healthy
 * REGISTERED name and makes it look RESERVED. `getState` also returns the
 * token id, which is the only safe way to obtain one.
 *
 * One call covers what `getStatus` + `findOwner` + `getExpiry` + `findTokenId`
 * did, which is how ensdomains/ens-cli reads a v2 name too; its results were
 * checked against those four on Sepolia for a REGISTERED, a RESERVED and an
 * AVAILABLE name and agree in every field.
 */
export const STATUS = ['AVAILABLE', 'RESERVED', 'REGISTERED'];

// --------------------------------------------------------------------------
// Encoding helpers.

/**
 * The `anyId` every registry setter takes. Use the labelhash, not the token id:
 * token ids are mutable (see STATUS above), so one captured before a role change
 * addresses nothing afterwards. The labelhash is stable for the life of the name.
 */
export const anyId = (label) => BigInt(keccak256(stringToHex(label)));

/**
 * One `getState` read for a label, with `status` decoded to a STATUS string.
 * Everything a caller needs to branch on — status, expiry, owner, token id —
 * comes back together, so two callers cannot see different points in time.
 */
export async function readNameState(publicClient, registry, label) {
  const state = await publicClient.readContract({
    address: registry,
    abi: registryAbi,
    functionName: 'getState',
    args: [anyId(label)]
  });
  return { ...state, status: STATUS[state.status] };
}

/**
 * VerifiableFactory salt schemes. The proxy address is fully determined by
 * (factory, msg.sender, salt), so the same call from the same sender always
 * lands on the same address — which is why a second deployProxy with the same
 * salt reverts on collision, and why a forked dry run predicts the live address.
 */
export function proxySalt(kind, keyType, key, version = 0n) {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: keyType }, { type: 'uint256' }],
        [keccak256(stringToHex(kind)), key, version]
      )
    )
  );
}

// --------------------------------------------------------------------------
// Raw JSON-RPC, for the anvil-only methods viem does not model.

export async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Spawn an anvil fork of Sepolia and wait for it to answer. Caller kills `child`. */
export async function startAnvil(forkUrl) {
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
