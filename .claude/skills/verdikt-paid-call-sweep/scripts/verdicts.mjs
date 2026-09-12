// What Verdikt actually recorded for the calls you just made.
//
//   node .claude/skills/verdikt-paid-call-sweep/scripts/verdicts.mjs [--blocks N] [--slug X] [--json]
//
// A paid call producing data is only half the loop. The point of Verdikt is
// that the call was *judged*: a verdict on Arc, and a refund credited from the
// provider's bond when the SLA was not met. So after a sweep, read it back —
// a sweep that returned nine good payloads and wrote zero verdicts means the
// verification path is broken, and nothing about the payloads would tell you.
//
// `--blocks` bounds the scan to the trailing N blocks (default 20000, about
// three hours at Arc's two-a-second). Without it this rescans from the deploy
// block, which is slower and mostly history you did not just create.

import { createRegistryReader } from '../../../../packages/sdk/arc.js';
import { json, loadEnv } from './lib.mjs';

loadEnv();

const asJson = process.argv.includes('--json');
const blocksFlag = process.argv.indexOf('--blocks');
const blocks = BigInt(blocksFlag === -1 ? 20000 : Number(process.argv[blocksFlag + 1]));
const slugFlag = process.argv.indexOf('--slug');
const onlySlug = slugFlag === -1 ? null : process.argv[slugFlag + 1];

const registry = createRegistryReader(
  process.env.ARC_RPC_URL ? {} : { maxBlockRange: 500n, scanConcurrency: 2 }
);

const head = await registry.client.getBlockNumber();
const fromBlock = head > blocks ? head - blocks : 0n;

// The service list is deliberately NOT windowed — `ServiceRegistered` has to be
// scanned in full or the slug->serviceId map comes back empty and every verdict
// below would be unattributable.
const [services, verdicts, refunds] = await Promise.all([
  registry.listServices(),
  registry.listVerdicts({ fromBlock }),
  registry.listRefunds({ fromBlock })
]);

const slugOf = new Map(services.map((service) => [service.serviceId, service.slug]));
const refundByRequest = new Map(refunds.map((refund) => [refund.requestId, refund]));

const rows = verdicts
  .map((verdict) => ({
    slug: slugOf.get(verdict.serviceId) ?? verdict.serviceId,
    outcome: verdict.outcome,
    payer: verdict.payer,
    paidAmount: verdict.paidAmount,
    refunded: refundByRequest.get(verdict.requestId)?.amount ?? 0n,
    requestId: verdict.requestId,
    blockNumber: verdict.blockNumber,
    transactionHash: verdict.transactionHash
  }))
  .filter((row) => !onlySlug || row.slug === onlySlug);

if (asJson) {
  console.log(json(rows));
} else {
  console.log(`Verdicts in blocks ${fromBlock}..${head} (${blocks} blocks):\n`);
  for (const row of rows) {
    // paidAmount is 6-decimal minor units (the x402 view); a refund is the
    // 18-decimal native amount the registry moved out of the bond.
    const paid = `$${(Number(row.paidAmount) / 1e6).toFixed(4)}`;
    const refund = row.refunded === 0n ? '' : `  refunded=$${(Number(row.refunded) / 1e18).toFixed(4)}`;
    console.log(
      `${row.slug.padEnd(14)} ${row.outcome.padEnd(5)} paid=${paid.padStart(8)}${refund}  ` +
        `payer=${row.payer.slice(0, 10)}…  ${row.transactionHash}`
    );
  }
  if (rows.length === 0) {
    console.log(
      '(none)\n\nNo verdict in this window. A paid call that returned data but wrote no verdict\n' +
        'means the response never reached the confidential workflow, or the workflow never\n' +
        'wrote — not that the call was fine. Widen with --blocks before concluding anything.'
    );
  } else {
    const tally = rows.reduce((counts, row) => ({ ...counts, [row.outcome]: (counts[row.outcome] ?? 0) + 1 }), {});
    console.log(`\n${rows.length} verdicts · ${JSON.stringify(tally)} · ${refunds.length} refunds credited`);
  }
}
