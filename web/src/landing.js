// The landing page.
//
// One continuous ruled sheet rather than a stack of marketing bands: every
// section is an entry, numbered in a mono rail on the far left and annotated in
// the outer margin, on the same hairlines the marketplace tables are set on.
// The numbering is load-bearing here — a ledger's lines are referenced by their
// index — which is the one thing that earns section numbers on a page like
// this. See web/.impeccable/surfaces/web-src-pages-js.md.
//
// Unlike pages.js, this one shows chain data, and all of it lives in entry 01:
// the platform figures moved here from the marketplace listing, and the margin
// beside them carries the most recent verdict the registry has actually
// written. Entry 00 has no margin at all — the hero states the terms and the
// proof of them sits one entry below, where the totals it summarises are.
// Figures and verdict degrade together to the chain's own identity while the
// first read is in flight, and the verdict's head flags "seeded" when no RPC is
// configured — a number on this page that could be mistaken for a real one is
// the single worst thing it could do.

import { html, nothing } from 'lit';
import { ARC } from '@verdikt/sdk';
import { formatMinorUsdc, formatNativeUsdc, shortHex } from './format.js';
import { HOW_PATH, MARKETPLACE_PATH, REGISTER_PATH, TRY_PATH, navigateOnClick } from './router.js';
import { TAGLINE } from './pages.js';
import './diagram.js';

const GITHUB_URL = 'https://github.com/imajus/verdikt';
const X_URL = 'https://x.com/denismajus';

/**
 * Splits "12.34 USDC" so the unit can be set quieter than the figure. Shared
 * with the detail and provider views, which set amounts the same way.
 * @param {string} value
 */
export const amount = (value) => {
  const [number, unit] = value.split(' ');
  return html`${number}${unit ? html` <small>${unit}</small>` : nothing}`;
};

/** @param {string} width */
const bar = (width) => html`<span class="bar" style="width:${width}"></span>`;

/** @param {string} label */
const skeletonFigure = (label) => html`<div class="figure skeleton"><span class="value">${bar('3.5rem')}</span><span class="label">${label}</span></div>`;

const PLATFORM_FIGURE_LABELS = ['services', 'bonded', 'verdicts', 'refunded'];

// Platform-wide totals. One ruled row, no tiles — the marketplace listing
// itself no longer shows these (see renderMarketplace).
/** @param {PlatformStats} stats */
export const platformFigures = (stats) => {
  const { PASS, FAIL, DOWN } = stats.breakdown;
  return html`<section class="figures"><div class="figure"><span class="value">${stats.services}</span><span class="label">services</span><span class="sub"><span>${stats.active} active</span>${stats.suspended ? html`<span>${stats.suspended} suspended</span>` : nothing}</span></div><div class="figure"><span class="value">${amount(formatNativeUsdc(stats.bonded, 2))}</span><span class="label">bonded</span></div><div class="figure"><span class="value">${stats.verdicts}</span><span class="label">verdicts</span>${stats.verdicts ? html`<div class="breakdown">${PASS ? html`<span class="seg pass" style="flex-grow:${PASS}"></span>` : nothing}${FAIL ? html`<span class="seg fail" style="flex-grow:${FAIL}"></span>` : nothing}${DOWN ? html`<span class="seg down" style="flex-grow:${DOWN}"></span>` : nothing}</div><span class="sub"><span class="pass"><i class="dot"></i>${PASS} pass</span><span class="fail"><i class="dot"></i>${FAIL} fail</span><span class="down"><i class="dot"></i>${DOWN} down</span></span>` : nothing}</div><div class="figure"><span class="value">${amount(formatNativeUsdc(stats.refunded, 2))}</span><span class="label">refunded</span><span class="sub"><span>${stats.refundCount} refund${stats.refundCount === 1 ? '' : 's'}</span></span></div></section>`;
};

export const platformFiguresSkeleton = () => html`<section class="figures">${PLATFORM_FIGURE_LABELS.map(skeletonFigure)}</section>`;

/**
 * The newest verdict on the registry, whichever service wrote it. `history` is
 * newest-first per listing, but the newest across listings still has to be
 * found by block.
 * @param {Marketplace|null} marketplace
 * @returns {{slug: string, verdict: ListingVerdict}|null}
 */
export function newestVerdict(marketplace) {
  /** @type {{slug: string, verdict: ListingVerdict}|null} */
  let newest = null;
  for (const listing of marketplace?.services ?? []) {
    for (const verdict of listing.history) {
      if (verdict.blockNumber === null) continue;
      if (newest === null || verdict.blockNumber > /** @type {bigint} */ (newest.verdict.blockNumber)) {
        newest = { slug: listing.slug, verdict };
      }
    }
  }
  return newest;
}

/**
 * One entry on the sheet: its index in the rail, its body on the measure, and
 * its annotation in the outer margin. The index is decorative for a screen
 * reader — nothing on the page refers to an entry by number — so the headings
 * carry the structure on their own.
 * @param {string} index @param {unknown} body @param {unknown} [note] @param {boolean} [wide]
 */
const entry = (index, body, note = nothing, wide = false) => html`
  <section class="entry ${wide ? 'entry-wide' : ''}">
    <p class="entry-index" aria-hidden="true">${index}</p>
    <div class="entry-body">${body}</div>
    ${note === nothing ? nothing : html`<aside class="entry-note">${note}</aside>`}
  </section>`;

/**
 * The margin beside the figures, and the page's only one. A chain address is
 * named here only where a chain was actually read: demo mode names none, and
 * says "seeded" in the head instead, because printing the real registry beside
 * numbers that did not come from it invites exactly the reading the flag denies.
 * On an error the body's own aside already names the failure, so this stays on
 * the one thing the body does not say — that nothing was estimated in its place.
 * @param {Marketplace|null} marketplace @param {'live'|'demo'} mode @param {string|null} error
 */
const verdictNote = (marketplace, mode, error) => {
  const newest = newestVerdict(marketplace);
  if (!newest) {
    return html`
      <p class="note-head">Latest verdict</p>
      <p class="note-line ${error ? 'warn' : 'muted'}">${error
        ? 'Nothing to read back, and nothing on this page estimated in its place.'
        : marketplace
          ? 'No paid call has been judged yet. A service nobody has called is presumed healthy — that is why a new listing scores 1000 and not 0.'
          : 'Reading the registry…'}</p>`;
  }
  const { slug, verdict } = newest;
  return html`
    <p class="note-head">Latest verdict${mode === 'demo' ? html` <span class="note-flag">seeded</span>` : nothing}</p>
    <dl class="note-kv">
      <dt>outcome</dt><dd><span class="outcome ${verdict.outcome.toLowerCase()}"><i class="dot"></i>${verdict.outcome}</span></dd>
      <dt>service</dt><dd>${slug}</dd>
      <dt>block</dt><dd>${verdict.blockNumber}</dd>
      <dt>paid</dt><dd>${formatMinorUsdc(verdict.paidAmount)}</dd>
      <dt>refunded</dt><dd>${verdict.refunded > 0n ? formatNativeUsdc(verdict.refunded, 2) : html`<span class="muted">none owed</span>`}</dd>
    </dl>
    ${mode === 'live' && ARC.registry
      ? html`<p class="note-line note-source">read from <code title=${ARC.registry}>${shortHex(ARC.registry)}</code> on Arc Testnet</p>`
      : nothing}`;
};

/**
 * Redacted bars mean "not in yet". They must never stand in for a read that
 * already failed — bars that never resolve are a placeholder pretending to be
 * a pending number.
 * @param {Marketplace|null} marketplace @param {string|null} error
 */
const figuresFor = (marketplace, error) => {
  if (marketplace) return platformFigures(marketplace.stats);
  if (error) return html`<p class="aside warn">The registry could not be read, so this page has no figures to show: ${error}</p>`;
  return platformFiguresSkeleton();
};

/**
 * @param {(path: string) => void} go
 * @param {Marketplace|null} [marketplace]
 * @param {'live'|'demo'} [mode]
 * @param {string|null} [error]
 */
export const landing = (go, marketplace = null, mode = 'demo', error = null) => html`
  <div class="ledger">
    ${entry('00', html`
      <h1 class="entry-lead"><span>Verified per call.</span><span>Refunded on failure.</span><span>No arbitration.</span></h1>
      <p class="tagline lead">${TAGLINE}</p>
      <p class="landing-cta">
        <wa-button href=${TRY_PATH} @click=${navigateOnClick(go, TRY_PATH)}>Try it — no wallet needed</wa-button>
        <wa-button appearance="outlined" href=${MARKETPLACE_PATH} @click=${navigateOnClick(go, MARKETPLACE_PATH)}>Browse the marketplace</wa-button>
        <wa-button appearance="outlined" href=${HOW_PATH} @click=${navigateOnClick(go, HOW_PATH)}>How the loop works</wa-button>
        ${mode === 'live' ? html`<a class="cta-aside" href=${REGISTER_PATH} @click=${navigateOnClick(go, REGISTER_PATH)}>or list a service of your own</a>` : nothing}
      </p>`)}

    ${entry('01', html`
      <h2>The record so far</h2>
      ${figuresFor(marketplace, error)}`, verdictNote(marketplace, mode, error))}

    ${entry('02', html`
      <h2>The payment is verifiable. The delivery is not.</h2>
      <p>x402 proves a call was paid for. Nothing proves it was answered. The promise lives in a README, the record of whether it was kept lives nowhere, and an arbitration queue would cost more than the call it was arguing about — so reliability stays whatever the provider says it is.</p>
      <p>Verdikt deletes the claim.</p>`, html`
      <p class="note-head">Why no dispute layer</p>
      <p class="note-line">A refund is money back, never a penalty: it cannot exceed what the call cost, or what is left of the provider’s bond. Breaking a call on purpose earns nothing, so there is nothing to appeal.</p>`)}

    ${entry('03', html`
      <h2>The request path</h2>
      <p>Two chains, one reason each. USDC is Arc’s native gas token, so the payment, the bond and the refund are all the same asset on the same chain.</p>
      <verdikt-diagram class="diagram"></verdikt-diagram>
      <p class="figure-source">The same loop in prose, including what happens to a 4xx and why an empty window scores 1000: <a href=${HOW_PATH} @click=${navigateOnClick(go, HOW_PATH)}>how it works</a>.</p>`, html`
      <p class="note-head">What never leaves</p>
      <p class="note-line">The observed value stays off the chain. It is a slice of a response the agent paid for, so it comes back to that agent on its own response as <code>x-verdikt-expected</code> and <code>x-verdikt-actual</code>, and to nobody else.</p>`, true)}

    ${entry('04', html`
      <div class="entry-split">
        <div class="split-col">
          <h2>Tell us what you are building</h2>
          <p>Say what you are pointing at this and what you need from it. A hole you have found in the mechanism is the most welcome message of the lot, and it reaches a person rather than a queue.</p>
          <verdikt-contact></verdikt-contact>
        </div>
        <div class="split-col">
          <h2>Be informed about our progress</h2>
          <p>The loop already runs end to end. Next comes what makes it usable by someone who is not us: a paid call carried the whole way, the workflow in production rather than in simulation, and a walkthrough you can watch. The newsletter is one short message as each of those lands, and nothing else.</p>
          <verdikt-subscribe></verdikt-subscribe>
          <p class="landing-social">
            <a class="cta-aside" href=${GITHUB_URL} target="_blank" rel="noopener noreferrer">Star the repository</a>
            <a class="cta-aside" href=${X_URL} target="_blank" rel="noopener noreferrer">Follow on X</a>
          </p>
        </div>
      </div>`, nothing, true)}
  </div>`;
