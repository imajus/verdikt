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

/** What `resolveServiceRecord('weather')` resolves to. Lets the proxy and dashboard build before Spike A lands. */
export const SERVICE_RECORD = Object.freeze({
  slug: FIXTURE_SLUG,
  name: 'weather.verdikt.eth',
  serviceId: '0x0000000000000000000000000000000000000000000000000000000000000000',
  address: FIXTURE_PROVIDER_PAYOUT,
  sla: '{"version":1,"clauses":[]}',
  conformance: 1000,
  availability: 1000,
  backend: 'fixture',
  resolvedAt: 0
});
