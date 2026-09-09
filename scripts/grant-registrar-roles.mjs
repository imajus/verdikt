#!/usr/bin/env node
// One-time role grant for VerdiktSubnameRegistrar (Tasks.md 5.3 stretch 1).
//
// WHAT THIS DOES
//
// After `DeployRegistrar.s.sol` deploys the contract, it holds no roles yet —
// it cannot call `claim()` successfully until the operator grants it exactly
// the two root roles `onboard-service.mjs`'s human operator already exercises
// today: ROLE_REGISTRAR on the subname registry (so it can call `register()`
// on a claimant's behalf) and RESOLVER_ROLES_VERDIKT_NEEDS on the resolver (so
// it can call `authorizeTextRoles` and `setAddr`). Verified against the live
// Sepolia bytecode via Sourcify — see VerdiktSubnameRegistrar.sol's own
// header for the exact chain of reasoning.
//
// Both grants are idempotent: `hasRootRoles` is checked first and a role
// already held is not re-granted, so a re-run after a partial failure resumes
// rather than reverts — same discipline as `setup-ens.mjs`.
//
//   node scripts/grant-registrar-roles.mjs             # plan, dry run
//   node scripts/grant-registrar-roles.mjs --send       # broadcast to Sepolia
//
// Environment:
//   ENS_DEPLOYER_PRIVATE_KEY — the verdikt.eth operator key. The same key
//                              onboard-service.mjs and setup-ens.mjs use.
//   SEPOLIA_RPC_URL           — optional, defaults to the SDK's public RPC.

import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { SEPOLIA } from '@verdikt/sdk/deployments';
import {
  DEFAULT_SEPOLIA_RPC,
  REGISTRY_ROLE_REGISTRAR,
  RESOLVER_ROLES_VERDIKT_NEEDS,
  registryAbi,
  resolverAbi
} from './ens-sepolia.mjs';

function parseArgs(argv) {
  return { send: argv.includes('--send') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const operatorKey = process.env.ENS_DEPLOYER_PRIVATE_KEY;
  if (!operatorKey) throw new Error('set ENS_DEPLOYER_PRIVATE_KEY');
  const rpcUrl = process.env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC;

  const registrar = SEPOLIA.subnameRegistrar;
  if (!registrar) {
    throw new Error(
      'deployments/sepolia.json has no subnameRegistrar address — run ' +
        'DeployRegistrar.s.sol first and record its address there.'
    );
  }

  const operator = privateKeyToAccount(operatorKey);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account: operator, chain: sepolia, transport: http(rpcUrl) });

  console.log(`  registrar         ${registrar}`);
  console.log(`  subnameRegistry   ${SEPOLIA.ens.subnameRegistry}`);
  console.log(`  resolver          ${SEPOLIA.ens.resolver}`);
  console.log(`  operator          ${operator.address}`);

  const hasRegistrarRole = await publicClient.readContract({
    address: SEPOLIA.ens.subnameRegistry,
    abi: registryAbi,
    functionName: 'hasRootRoles',
    args: [REGISTRY_ROLE_REGISTRAR, registrar]
  });
  const hasResolverRoles = await publicClient.readContract({
    address: SEPOLIA.ens.resolver,
    abi: resolverAbi,
    functionName: 'hasRootRoles',
    args: [RESOLVER_ROLES_VERDIKT_NEEDS, registrar]
  });

  console.log(`\n  ROLE_REGISTRAR granted?              ${hasRegistrarRole}`);
  console.log(`  RESOLVER_ROLES_VERDIKT_NEEDS granted? ${hasResolverRoles}`);

  if (!args.send) {
    console.log('\n  dry run — pass --send to broadcast whatever is still missing.');
    return;
  }

  const send = async (params) => {
    const { request } = await publicClient.simulateContract({ account: operator, ...params });
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`reverted: ${hash}`);
    return hash;
  };

  if (!hasRegistrarRole) {
    console.log('\n  granting ROLE_REGISTRAR on the subname registry…');
    await send({
      address: SEPOLIA.ens.subnameRegistry,
      abi: registryAbi,
      functionName: 'grantRootRoles',
      args: [REGISTRY_ROLE_REGISTRAR, registrar]
    });
  }
  if (!hasResolverRoles) {
    console.log('  granting RESOLVER_ROLES_VERDIKT_NEEDS on the resolver…');
    await send({
      address: SEPOLIA.ens.resolver,
      abi: resolverAbi,
      functionName: 'grantRootRoles',
      args: [RESOLVER_ROLES_VERDIKT_NEEDS, registrar]
    });
  }

  console.log('\nDone. The registrar can now run claim() for any slug.');
}

main().catch((error) => {
  console.error(`\ngrant failed: ${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
