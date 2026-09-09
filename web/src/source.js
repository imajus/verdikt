// Where the dashboard's data comes from.
//
// Two sources, and the UI says which one it is looking at. Arc Testnet has no
// deployed registry yet (Tasks.md 2.4 is blocked on an RPC URL and a funded
// key), so a marketplace with nothing to show would be indistinguishable from a
// marketplace that is broken. The demo source makes the surface reviewable now
// and is labelled in the header so nobody mistakes it for live data.

import { ARC, ENS_BACKEND, createRegistryReader, resolveServiceRecord, serviceIdOf } from '@verdikt/sdk';
import { SLA_TEXT } from '@verdikt/fixtures';
import { DELIVERY_CLAUSE, NO_CLAUSE, clauseHash } from '@verdikt/sdk/registry';

/**
 * @param {Record<string, string|undefined>} env
 * @returns {{ mode: 'live'|'demo', deps: MarketplaceDeps }}
 */
export function createSource(env) {
  // The registry address is not a per-environment setting — it comes from
  // deployments/arc-testnet.json, bundled at build time. All the dashboard
  // needs told is which RPC to read it through.
  const registryAddress = ARC.registry;
  if (registryAddress && env.VITE_ARC_RPC_URL) {
    const registry = createRegistryReader({
      rpcUrl: env.VITE_ARC_RPC_URL,
      address: registryAddress,
      deployBlock: ARC.deployBlock ? BigInt(ARC.deployBlock) : undefined
    });
    return {
      mode: 'live',
      deps: {
        registry,
        resolve: (slug) => resolveServiceRecord(slug, { rpcUrl: env.VITE_SEPOLIA_RPC_URL, cacheTtlMs: 30_000 })
      }
    };
  }
  return { mode: 'demo', deps: demoSource() };
}

/**
 * The two demo services from Tasks.md 6.1 — one honouring its SLA, one whose
 * twin cannot meet it — with a history that walks the failing one all the way
 * to SUSPENDED. That last part matters: a deposit running out is what gives a
 * verdict teeth, and a marketplace that never shows it is only showing the
 * happy path.
 *
 * @returns {MarketplaceDeps}
 */
function demoSource() {
  const honest = serviceIdOf('weather');
  const flaky = serviceIdOf('weather-lite');

  /** @type {RegisteredService[]} */
  const services = [
    { serviceId: honest, slug: 'weather', provider: '0xA11ce00000000000000000000000000000000001', status: 'ACTIVE', deposit: 10n * 10n ** 18n, registeredAtBlock: 100n },
    { serviceId: flaky, slug: 'weather-lite', provider: '0xB0b0000000000000000000000000000000000002', status: 'SUSPENDED', deposit: 0n, registeredAtBlock: 120n }
  ];

  /** @type {VerdictRecord[]} */
  const verdicts = [];
  /** @type {RefundRecord[]} */
  const refunds = [];
  const payer = '0x1111111111111111111111111111111111111111';

  for (let i = 0; i < 24; i += 1) {
    const down = i === 11;
    verdicts.push({
      serviceId: honest,
      requestId: `0x${(i + 1).toString(16).padStart(64, '0')}`,
      outcome: down ? 'DOWN' : 'PASS',
      payer,
      paidAmount: 2500n,
      // The one outage failed to deliver at all, so it names the implicit
      // clause rather than one the provider wrote. A PASS names none.
      failedClause: down ? clauseHash(DELIVERY_CLAUSE) : NO_CLAUSE,
      blockNumber: 200n + BigInt(i),
      transactionHash: `0x${'a'.repeat(63)}${i.toString(16)}`
    });
  }
  // Every call to the twin fails: its SLA promises a humidity field the upstream
  // does not return, and a latency no round trip can meet.
  for (let i = 0; i < 10; i += 1) {
    const requestId = `0x${(100 + i).toString(16).padStart(64, '0')}`;
    verdicts.push({
      serviceId: flaky,
      requestId,
      outcome: 'FAIL',
      payer,
      paidAmount: 2500n,
      // Both the schema and the latency clause break on every call; the verdict
      // carries the first in the SLA's own declared order.
      failedClause: clauseHash('current-weather-shape'),
      blockNumber: 300n + BigInt(i),
      transactionHash: `0x${'b'.repeat(63)}${i.toString(16)}`
    });
    refunds.push({ serviceId: flaky, requestId, payer, amount: 10n ** 18n, blockNumber: 300n + BigInt(i) });
  }

  /** @type {Record<string, ServiceRecord>} */
  const records = {
    weather: {
      slug: 'weather',
      name: 'weather.verdikt.eth',
      serviceId: honest,
      address: '0x2222222222222222222222222222222222222222',
      url: 'https://weather.demo.verdikt.bond/v1/current',
      sla: SLA_TEXT.honest,
      conformance: 1000,
      availability: 958,
      owner: '0xA11ce00000000000000000000000000000000001',
      backend: ENS_BACKEND.FIXTURE,
      resolvedAt: 0
    },
    'weather-lite': {
      slug: 'weather-lite',
      name: 'weather-lite.verdikt.eth',
      serviceId: flaky,
      address: '0x3333333333333333333333333333333333333333',
      url: 'https://weather-lite.demo.verdikt.bond/v1/current',
      sla: SLA_TEXT.violating,
      conformance: 0,
      availability: 1000,
      owner: '0xB0b0000000000000000000000000000000000002',
      backend: ENS_BACKEND.FIXTURE,
      resolvedAt: 0
    }
  };

  return {
    registry: {
      listServices: async () => services,
      listVerdicts: async () => verdicts,
      listRefunds: async () => refunds
    },
    resolve: async (slug) => {
      const record = records[slug];
      if (!record) throw new Error(`no demo record for ${slug}`);
      return record;
    }
  };
}
