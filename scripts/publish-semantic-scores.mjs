// Publish `semanticConformance` to each service's subname (issue #92).
//
// A separate mechanism from the hourly CRE aggregate, deliberately. That one
// scans `VerdictWritten` on Arc inside a workflow and writes through
// `VerdiktScoreWriter`; this one reads claims off GenLayer and writes from an
// EOA. Different chain, different source of truth, different signer — and the
// per-key EAC is what keeps them apart: a compromised GenLayer aggregator must
// not be able to move a provider's `conformance`.
//
// It takes the claims as JSON rather than reading GenLayer itself. Reading
// GenLayer means its own calldata codec, which `genlayer-py` already has on the
// other side of this repo and which this side would have to carry a browser SDK
// for. So the export is Python and the write is JS, and the seam between them is
// a file — which is a feature for a number that ranks providers publicly: the
// exact input a published score came from is worth being able to look at.
//
//   cd genlayer && .venv/bin/python scripts/export-claims.py > /tmp/claims.json
//   node --env-file-if-exists=.env scripts/publish-semantic-scores.mjs --claims /tmp/claims.json
//   node --env-file-if-exists=.env scripts/publish-semantic-scores.mjs --claims /tmp/claims.json --send
//   node --env-file-if-exists=.env scripts/publish-semantic-scores.mjs --claims /tmp/claims.json --grant --send
//
// Without --send it prints what it would write and changes nothing.
//
// --grant runs the one-time `authorizeTextRoles` that scopes the signer to the
// `semanticConformance` key on each subname. It is separate because it needs
// the *operator* key, not the signer's, and because a subname minted before
// this key existed has nobody authorised for it — the first write reverts with
// `EACUnauthorizedAccountRoles` until the grant lands.

import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createRegistryReader, resolveServiceRecord, writeSemanticScore } from '@verdikt/sdk';
import { SEPOLIA } from '@verdikt/sdk/deployments';
import { dnsEncode, serviceName } from '@verdikt/sdk/ens';
import { aggregateSemantic } from '@verdikt/sla';
import { DEFAULT_SEPOLIA_RPC, resolverAbi } from './ens-sepolia.mjs';

const SEMANTIC_KEY = 'semanticConformance';

function parseArgs(argv) {
  const valueOf = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    send: argv.includes('--send'),
    grant: argv.includes('--grant'),
    claims: valueOf('claims'),
    rpcUrl: valueOf('rpc', process.env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.claims) {
    throw new Error('no claims file — run genlayer/scripts/export-claims.py first and pass --claims');
  }
  const exported = JSON.parse(readFileSync(args.claims, 'utf8'));

  const signerKey = process.env.ENS_SEMANTIC_SIGNER_PRIVATE_KEY ?? process.env.ENS_SCORE_SIGNER_PRIVATE_KEY;
  if (!signerKey) throw new Error('ENS_SEMANTIC_SIGNER_PRIVATE_KEY (or ENS_SCORE_SIGNER_PRIVATE_KEY) is unset');
  const signer = privateKeyToAccount(signerKey);

  const settlements = Array.isArray(exported.claims) ? exported.claims : [];
  console.log(`judge    ${exported.judge ?? '(unknown)'} on ${exported.network ?? '(unknown)'}`);
  console.log(`signer   ${signer.address}`);
  console.log(`claims   ${settlements.length}`);

  // Every registered service, not only the disputed ones. A provider whose
  // only claim was dismissed should see 1000 published, and a provider nobody
  // has disputed should see 1000 too — neither is served by silence.
  const services = await createRegistryReader().listServices();
  const bySlug = new Map();
  for (const claim of settlements) {
    const slug = String(claim.slug ?? '');
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push({ outcome: String(claim.outcome ?? 'OPEN') });
  }

  const plan = services.map((service) => {
    const score = aggregateSemantic(bySlug.get(service.slug) ?? []);
    return { slug: service.slug, ...score };
  });

  for (const row of plan) {
    console.log(
      `  ${row.slug.padEnd(20)} ${String(row.semanticConformance).padStart(4)}  ` +
        `(${row.counts.met} met, ${row.counts.breach} breach, ${row.counts.undecided} undecided)`
    );
  }

  if (!args.send) {
    console.log('\ndry run — pass --send to broadcast.');
    if (!args.grant) console.log('Add --grant if the signer has never written this key on these subnames.');
    return;
  }

  if (args.grant) await grantRoles(args, plan, signer.address);

  for (const row of plan) {
    const hash = await writeSemanticScore(row.slug, row.semanticConformance, {
      rpcUrl: args.rpcUrl,
      privateKey: signerKey
    });
    console.log(`  wrote ${row.slug} -> ${row.semanticConformance}  ${hash}`);
  }

  // Read back, always. A write that mined is not a write that landed — this
  // repo learned that from a forwarder that swallowed a receiver revert and
  // reported success (CLAUDE.md, "Two silent failures").
  console.log('\nreading back…');
  for (const row of plan) {
    const record = await resolveServiceRecord(row.slug, { rpcUrl: args.rpcUrl });
    const ok = record.semanticConformance === row.semanticConformance;
    console.log(`  ${row.slug.padEnd(20)} ${String(record.semanticConformance).padStart(4)}  ${ok ? 'ok' : 'MISMATCH'}`);
    if (!ok) process.exitCode = 1;
  }
}

/**
 * Scope the signer to `semanticConformance` on each subname, once.
 *
 * `authorizeTextRoles`, per key — never `authorizeNameRoles`. Spike A found
 * the name-wide grant to be one of the two ways the per-key ACL can be
 * bypassed, and a semantic aggregator that could write `conformance` would
 * undo the whole point of keeping the two scores apart.
 */
async function grantRoles(args, plan, signerAddress) {
  const operatorKey = process.env.ENS_DEPLOYER_PRIVATE_KEY;
  if (!operatorKey) throw new Error('--grant needs ENS_DEPLOYER_PRIVATE_KEY (the resolver operator)');
  const operator = privateKeyToAccount(operatorKey);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(args.rpcUrl) });
  const wallet = createWalletClient({ account: operator, chain: sepolia, transport: http(args.rpcUrl) });
  const resolver = SEPOLIA.ens.resolver;

  console.log(`\ngranting ${SEMANTIC_KEY} to ${signerAddress} as ${operator.address}…`);
  for (const row of plan) {
    const dnsName = dnsEncode(serviceName(row.slug));
    const { request } = await publicClient.simulateContract({
      account: operator,
      address: resolver,
      abi: resolverAbi,
      functionName: 'authorizeTextRoles',
      args: [dnsName, SEMANTIC_KEY, signerAddress, true]
    });
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`grant reverted for ${row.slug}: ${hash}`);
    console.log(`  ${row.slug} granted`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
