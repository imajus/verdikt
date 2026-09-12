// Every service the Arc registry knows, with its live status.
//
//   node .claude/skills/paid-call-sweep/scripts/list-services.mjs [--all] [--json]
//
// Default output is the listed services only — the ones an agent could
// actually call. `--all` adds the DEREGISTERED rows, which stay in the event
// log forever (their bond was returned and their slug can never be
// re-registered, so the proxy answers `service_not_active` to any call).
//
// There is no subgraph: the slug->serviceId mapping exists only in
// `ServiceRegistered` logs, because keccak256 is one-way and the registry does
// not store the string. So this is a log scan from the registry's deploy block,
// and on Arc — which mints two blocks a second — that range only grows.

import { createRegistryReader } from '../../../../packages/sdk/arc.js';
import { json, loadEnv } from './lib.mjs';

loadEnv();

const all = process.argv.includes('--all');
const asJson = process.argv.includes('--json');

// Arc's public RPC caps `eth_getLogs` hard enough that the SDK's 10k default
// gets refused mid-scan with `-32005 rate limit exceeded`. A credentialed
// endpoint (root `.env`'s ARC_RPC_URL) takes the default happily and is ~20x
// fewer round trips, so only narrow the chunk when we're on the public one.
const rpcUrl = process.env.ARC_RPC_URL;
const registry = createRegistryReader(
  rpcUrl ? {} : { maxBlockRange: 500n, scanConcurrency: 2 }
);
if (!rpcUrl) {
  console.error(
    '[sweep] ARC_RPC_URL unset — scanning Arc\'s public RPC in 500-block chunks.\n' +
      '        This takes minutes rather than seconds. Set ARC_RPC_URL in the root .env.'
  );
}

const services = await registry.listServices();
const listed = services.filter((service) => service.status !== 'DEREGISTERED');
const rows = all ? services : listed;

if (asJson) {
  console.log(json(rows));
} else {
  for (const service of rows) {
    // Arc's native USDC is 18-decimal; the 6-decimal ERC-20 view is what x402
    // prices in. Deposits are `msg.value`, so they are the 18-decimal kind.
    const bond = (Number(service.deposit) / 1e18).toFixed(3);
    console.log(
      `${service.slug.padEnd(14)} ${service.status.padEnd(13)} bond=${bond.padStart(7)} USDC  ` +
        `provider=${service.provider}  https://${service.slug}.verdikt.bond/`
    );
  }
  console.log(
    `\n${listed.length} listed` +
      (all ? ` · ${services.length - listed.length} deregistered · ${services.length} total` : '')
  );
}
