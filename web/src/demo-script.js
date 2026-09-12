// The scripted "try it" chat on /try (issue #66). Every claim it makes links
// out to a real, already-mined transaction or a real contract, taken verbatim
// from docs/evidence/ rather than a live RPC call — so the demo can't go
// stale or break during judging, and needs no wallet or gas from whoever is
// looking at it.
//
// The scenario is weather-lite's recorded FAIL
// (docs/evidence/clause-detail-live.log): its SLA promises a
// `relative_humidity_2m` field the upstream doesn't return, so
// `current-weather-shape` breaks and the refund credits automatically,
// capped at exactly what was paid.
//
// Two of the links below are each real on their own chain but not yet one
// continuous transaction, and DEMO_DISCLOSURE says so rather than letting the
// chat imply otherwise — the same honesty docs/shot-list.md's own closing
// disclaimer applies to the enclave and the fixture payer:
//
//   - the payment is docs/evidence/x402-payment-live.log's real signature,
//     accepted by Base Sepolia's USDC contract directly. Verdikt's own demo
//     paywall doesn't yet carry a payment header through to a judged call
//     (docs/walkthrough.md, "What this does not show") — that gap is the
//     provider's, not the verifier's.
//   - the verdict and refund are a real Arc Testnet write from that same
//     failure mode, but against FIXTURE_PAYER (fixtures/index.js): an
//     address with no private key behind it, chosen specifically so it could
//     never be mistaken for a real one. Nobody can run withdraw() against
//     this credit for the same reason nobody could have forged it — there is
//     no key to sign with.
//
// The CRE workflow that judged the call is also the simulator, not a
// deployed TEE: production enrollment is still pending (CLAUDE.md).
//
// The Arc Testnet explorer is https://testnet.arcscan.app (the `use-arc`
// skill's own reference) — not `explorer.testnet.arc.network`, which
// web/.impeccable/surfaces/web-src-lit-app-js.md already found does not
// resolve, even though docs/walkthrough.md still links to it. Both the
// registry address and the verdict tx below were read back from arcscan's
// own API before being hardcoded here.

import { serviceUrl } from './router.js';

const ARC_EXPLORER = 'https://testnet.arcscan.app';
const REGISTRY = '0xE182626142E63EF440421cb0c5e4DEbeEF76E4Af';
const VERDICT_TX = '0x3f136dcbbe5d5ca88dee63da5ef1a9efba065ce81bcb27f7d5f90c377463ef4f';
const PAYMENT_TX = '0xc2e071e6e5701a87fe1d66a2500b4b88935aa8dbbeb4bb14db46c1496c81d061';

export const DEMO_SLUG = 'weather-lite';
export const DEMO_SERVICE_URL = serviceUrl(DEMO_SLUG);

/**
 * @typedef {{
 *   from: 'agent'|'verdikt'|'record',
 *   text: string,
 *   link?: { label: string, href: string, internal?: boolean }
 * }} DemoStep
 */

/** @type {DemoStep[]} */
export const DEMO_STEPS = [
  {
    from: 'agent',
    text: `I call ${DEMO_SLUG}.verdikt.bond. It answers 402 with its own challenge, so I sign the payment it asked for and send that back.`,
    link: { label: 'The signed payment — accepted directly by Base Sepolia’s USDC contract', href: `https://sepolia.basescan.org/tx/${PAYMENT_TX}` }
  },
  {
    from: 'verdikt',
    text: `Payment received. Replaying the call inside the confidential workflow, and checking the response against ${DEMO_SLUG}’s own published SLA — not Verdikt’s description of it, the provider’s.`
  },
  {
    from: 'verdikt',
    text: `FAIL. The SLA promises a relative_humidity_2m field in every response; this one doesn’t have it. Clause current-weather-shape breaks — not just that it failed, which promise it broke.`,
    link: { label: 'The verdict, written on Arc Testnet', href: `${ARC_EXPLORER}/tx/${VERDICT_TX}` }
  },
  {
    from: 'verdikt',
    text: `No ticket, no arbitration queue, no waiting on a human: the same write that records the FAIL books the refund against ${DEMO_SLUG}’s bond, capped at exactly what was paid — never a penalty on top.`,
    link: { label: 'Same transaction — the credit is booked, not sent', href: `${ARC_EXPLORER}/tx/${VERDICT_TX}` }
  },
  {
    from: 'verdikt',
    text: `That credit sits on the registry until the payer calls withdraw() to collect it. Verdikt never pushes it — a payer that rejects transfers could otherwise revert the call and erase its own FAIL.`,
    link: { label: 'The registry holding it, on Arc Testnet', href: `${ARC_EXPLORER}/address/${REGISTRY}` }
  },
  {
    from: 'record',
    text: `Paid, judged against the provider’s own promise, refunded — with nobody arbitrating any of it. ${DEMO_SLUG} was deregistered after this run (its bond went back to the provider), so it won’t turn up in the marketplace list, but every verdict below is exactly what got recorded.`,
    link: { label: `${DEMO_SLUG}’s full verdict history`, href: DEMO_SERVICE_URL, internal: true }
  }
];

export const DEMO_DISCLOSURE =
  'Two of the links above are each real on their own chain, not yet one continuous transaction. The payment is a live signature that Base Sepolia’s USDC contract accepted directly; the verdict and refund are a live Arc Testnet write from this exact failure. Stitching them into one paid call is the one piece still open — Verdikt’s demo paywall advertises the payment scheme and then still answers 402 to it, and that gap is the provider’s, not the verifier’s. This verdict’s payer is also a fixture address with no private key behind it, by design, so nobody has actually run withdraw() against this one credit — the credit itself, and the logic that would pay it out, are both real. And the enclave is CRE’s simulator, not a deployed TEE: production enrollment is still pending.';
