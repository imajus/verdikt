// The scripted "try it" chat embedded on the landing page (issue #66). Every
// claim it makes links out to a real, already-mined transaction or a real
// contract, taken verbatim from docs/evidence/ rather than a live RPC call —
// so the demo can't go stale or break during judging, and needs no wallet or
// gas from whoever is looking at it.
//
// The frame is a paying agent working on someone's behalf, not Verdikt
// narrating its own mechanism: a visitor asks for something in plain
// language, the log beneath is what their agent actually does to get it, and
// the reply is what it tells the person who asked — the service itself, not
// the provider's identity or the proxy route (a hostname is wiring, not
// something a person reads), the charge, and the fact that it came back.
// The closing step is a bare link back to the full verdict history, for
// whoever wants the record rather than the summary.
//
// The scenario is weather-lite's recorded FAIL
// (docs/evidence/clause-detail-live.log): its SLA promises a
// `relative_humidity_2m` field the upstream doesn't return, so
// `current-weather-shape` breaks and the refund credits automatically,
// capped at exactly what was paid.
//
// Every figure below is that one verdict's own record, read back off Arc in
// clause-detail-live.log §3, requestId 0x0606…: paidAmount 2500 minor units
// (0.0025 USDC), refundCredited 2.5e15 wei of native USDC (0.0025 USDC again
// — the cap binding at what was paid), and the 87ms the enclave measured for
// the provider's answer in §2. They are deliberately all from the same
// record: the Base Sepolia signature this demo also links is a separate leg
// for a different amount (1 minor unit, x402-payment-live.log), so no money
// figure is ever attached to that line. Mixing the two legs' numbers into
// one flow would print a total that never happened.
//
// The Arc Testnet explorer is https://testnet.arcscan.app (the `use-arc`
// skill's own reference) — not `explorer.testnet.arc.network`, which
// web/.impeccable/surfaces/web-src-lit-app-js.md already found does not
// resolve, even though docs/walkthrough.md still links to it. Both the
// registry address and the verdict tx below were read back from arcscan's
// own API before being hardcoded here.

import { serviceUrl } from './router.js';

const ARC_EXPLORER = 'https://testnet.arcscan.app';
const VERDICT_TX = '0x3f136dcbbe5d5ca88dee63da5ef1a9efba065ce81bcb27f7d5f90c377463ef4f';
const PAYMENT_TX = '0xc2e071e6e5701a87fe1d66a2500b4b88935aa8dbbeb4bb14db46c1496c81d061';

export const DEMO_SLUG = 'weather-lite';
export const DEMO_SERVICE_URL = serviceUrl(DEMO_SLUG);
/** The proxy route the agent actually calls. `{host}` in any step's text renders it underlined. */
export const DEMO_HOST = `${DEMO_SLUG}.verdikt.bond`;

/** What the judged call cost and what came back — the same figure, because the refund cap binds at what was paid. */
export const DEMO_PAID = '0.0025 USDC';
export const DEMO_REFUNDED = '0.0025 USDC';
/** What the enclave measured for the provider's answer. */
export const DEMO_LATENCY = '87 ms';

export const DEMO_USER_MESSAGE = 'Get weather for today in New York.';
export const DEMO_REPLY = 'Sorry, something went wrong — the weather service isn’t answering properly right now. The {amount} it charged was refunded automatically, so you are not out of pocket. I’ll try a different service.';

/**
 * A log step's `link` is not a footnote under the line — its `label` opens the
 * line and the `text` finishes the sentence, so the evidence is the thing you
 * read rather than an afterthought hanging off it. The label therefore names
 * what is on the other side (which chain, which record), because inline it is
 * all a reader gets before clicking.
 *
 * Three substitution tokens, each so a value keeps typography a plain string
 * cannot carry: `{amount}` in prose becomes mono (DESIGN.md's chain-data rule
 * — a chain value never ships in the sans face), `{outcome}` becomes the
 * dotted PASS/FAIL mark the ledger tables use, and `{host}` underlines the
 * proxy route wherever it is named. The closing step carries a link and no
 * text at all: the record speaks for itself.
 * @typedef {{
 *   kind: 'user'|'log'|'reply'|'coda',
 *   text: string,
 *   link?: { label: string, href: string, internal?: boolean },
 *   outcome?: 'fail',
 *   amount?: string
 * }} DemoStep
 */

/** @type {DemoStep[]} */
export const DEMO_SCRIPT = [
  { kind: 'user', text: DEMO_USER_MESSAGE },
  { kind: 'log', text: 'Send HTTP request to {host}' },
  { kind: 'log', text: `Received 402 Payment Required — price ${DEMO_PAID}` },
  { kind: 'log', text: 'Signed payment, resent the request' },
  {
    kind: 'log',
    text: '— accepted by Base Sepolia’s USDC contract',
    link: { label: 'Payment received', href: `https://sepolia.basescan.org/tx/${PAYMENT_TX}` }
  },
  { kind: 'log', text: `Provider answered 200 in ${DEMO_LATENCY}` },
  {
    kind: 'log',
    text: 'is {outcome} — response is missing the advertised data',
    outcome: 'fail',
    link: { label: 'On-chain verdict', href: `${ARC_EXPLORER}/tx/${VERDICT_TX}` }
  },
  {
    kind: 'log',
    text: `— ${DEMO_REFUNDED}`,
    link: { label: 'Refund booked', href: `${ARC_EXPLORER}/tx/${VERDICT_TX}` }
  },
  { kind: 'reply', text: DEMO_REPLY, amount: DEMO_PAID },
  { kind: 'coda', text: '', link: { label: `${DEMO_SLUG}’s full verdict history`, href: DEMO_SERVICE_URL, internal: true } }
];
