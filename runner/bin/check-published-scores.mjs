// Read back what the hourly aggregate run actually published (Tasks.md 3.2).
//
// This exists because of the failure mode in CLAUDE.md: the KeystoneForwarder
// swallows a receiver revert and still mines, so `txStatus === SUCCESS` means
// the forwarder ran, never that `VerdiktScoreWriter` wrote. The workflow's own
// summary line is therefore not evidence, and the only evidence is the text
// record on Sepolia. Without this step a scheduled publish that has silently
// written nothing for a week looks exactly like one that works.
//
// The check mirrors `reputationForWindow`'s notion of a live listing: every
// ACTIVE or SUSPENDED service is expected to carry both scores, and a
// DEREGISTERED one is not — its bond has gone home and its subname is no
// longer a listing.
//
// Exits non-zero when a live listing is missing either score, so a Dokploy job
// turns red rather than logging a reassuring wall of text.

import { createRegistryReader } from '@verdikt/sdk/arc';
import { resolveServiceRecord } from '@verdikt/sdk/ens';

/** Sepolia read-your-writes lag. `--broadcast` waits for the receipt, so this
 *  covers only the gap between a mined block and the read RPC serving it. */
const SETTLE_MS = Number(process.env.SCORE_CHECK_SETTLE_MS ?? 5000);

const LIVE = new Set(['ACTIVE', 'SUSPENDED']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (SETTLE_MS > 0) await sleep(SETTLE_MS);

  const services = (await createRegistryReader().listServices()).filter((service) => LIVE.has(service.status));
  if (services.length === 0) {
    console.log('check-published-scores: no live listings on Arc — nothing to publish');
    return;
  }

  // Sequential rather than Promise.all: this runs hourly against a shared
  // RPC allowance, and a handful of services is not worth the burst.
  const missing = [];
  for (const service of services) {
    const record = await resolveServiceRecord(service.slug).catch((error) => error);
    if (record instanceof Error) {
      // An unreachable resolver is not a failed publish (packages/sdk/ens.js
      // draws exactly this line), so it is reported and not counted.
      console.log(`  ${service.slug.padEnd(14)} ENS unreachable: ${record.message.split('\n')[0]}`);
      continue;
    }
    const published = record.conformance !== null && record.availability !== null;
    console.log(
      `  ${service.slug.padEnd(14)} conformance=${String(record.conformance ?? '—').padStart(4)}` +
        `  availability=${String(record.availability ?? '—').padStart(4)}`
    );
    if (!published) missing.push(service.slug);
  }

  if (missing.length > 0) {
    console.error(
      `check-published-scores: ${missing.length} live listing(s) carry no scores after a broadcast run: ` +
        `${missing.join(', ')}. The forwarder reports success even when the receiver reverts — check that ` +
        'VerdiktScoreWriter holds the conformance/availability text roles on those subnames.'
    );
    process.exitCode = 1;
    return;
  }

  console.log(`check-published-scores: all ${services.length} live listing(s) carry both scores`);
}

main().catch((error) => {
  console.error(`check-published-scores failed: ${error.message}`);
  process.exitCode = 1;
});
