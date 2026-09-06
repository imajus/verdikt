// @verdikt/fixtures — the frozen inputs every other package develops against,
// so no test needs a live paid call (Tasks.md 0.5).
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ EVERYTHING HERE IS SYNTHETIC. None of it has been captured from a real   │
// │ call yet. Tasks.md 0.4 and 0.5 replace these with recorded artefacts:    │
// │ a real 402 challenge, a real GatewayWalletBatched X-PAYMENT header, the  │
// │ provider's 200 response, and the settlement receipt. Shapes below are    │
// │ placeholders and are expected to change once those land.                 │
// └──────────────────────────────────────────────────────────────────────────┘

import HONEST_SLA from './sla/honest.json' with { type: 'json' };
import VIOLATING_SLA from './sla/violating.json' with { type: 'json' };

/** Placeholder — all-hex-digit so it is checksum-agnostic and obviously not real. */
export const FIXTURE_PAYER = '0x1111111111111111111111111111111111111111';

export const FIXTURE_PROVIDER_PAYOUT = '0x2222222222222222222222222222222222222222';

export const FIXTURE_SLUG = 'weather';

/** Opaque to everything except `decodePayment`. Not a real header. */
export const X_PAYMENT_HEADER = 'eyJzY2hlbWUiOiJHYXRld2F5V2FsbGV0QmF0Y2hlZCIsIlBMQUNFSE9MREVSIjp0cnVlfQ==';

/** What `decodePayment` resolves the header above to. 2500n = $0.0025 at USDC's 6 decimals. */
export const DECODED_PAYMENT = Object.freeze({
  payer: FIXTURE_PAYER,
  amount: 2500n
});

/** The demo slug whose SLA its provider honours. */
export const FIXTURE_VIOLATING_SLUG = 'weather-lite';

/**
 * The two demo SLAs (Tasks.md 1.1): one the demo service honours, one its twin
 * deliberately violates. Exported both parsed and as the exact text a provider
 * writes into the `sla` ENS record — the ENS layer stores a raw string, and
 * round-tripping through `JSON.stringify` at the call site would hide any
 * whitespace the record actually carries.
 */
export const SLA_DOCUMENTS = Object.freeze({
  honest: HONEST_SLA,
  violating: VIOLATING_SLA
});

export const SLA_TEXT = Object.freeze({
  honest: JSON.stringify(HONEST_SLA),
  violating: JSON.stringify(VIOLATING_SLA)
});

/** A conforming upstream response — Open-Meteo's `current` block, as the demo paywall relays it. */
export const PROVIDER_RESPONSE = Object.freeze({
  latitude: 52.52,
  longitude: 13.41,
  generationtime_ms: 0.0349,
  utc_offset_seconds: 0,
  timezone: 'GMT',
  elevation: 38,
  current: Object.freeze({
    time: '2026-09-07T10:00',
    interval: 900,
    temperature_2m: 12.5,
    wind_speed_10m: 9.1
  })
});

/** What `resolveServiceRecord('weather')` resolves to. Lets the proxy and dashboard build against a known shape. */
export const SERVICE_RECORD = Object.freeze({
  slug: FIXTURE_SLUG,
  name: 'weather.verdikt.eth',
  serviceId: '0x0000000000000000000000000000000000000000000000000000000000000000',
  address: FIXTURE_PROVIDER_PAYOUT,
  sla: JSON.stringify(HONEST_SLA),
  conformance: 1000,
  availability: 1000,
  backend: 'fixture',
  resolvedAt: 0
});
