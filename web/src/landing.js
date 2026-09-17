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
import { formatMinorUsdc, formatNativeUsdc } from './format.js';
import { HOW_PATH, MARKETPLACE_PATH, PRIVACY_PATH, REGISTER_PATH, navigateOnClick } from './router.js';
import { TAGLINE } from './pages.js';
import './demo-chat.js';

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
  // The verdicts bar carries the split on its own: the counts it used to
  // spell out under it are in its label for a screen reader and a hover.
  const split = `${PASS} pass, ${FAIL} fail, ${DOWN} down`;
  return html`<section class="figures"><div class="figure"><span class="value">${stats.services}</span><span class="label">services</span></div><div class="figure"><span class="value">${amount(formatNativeUsdc(stats.bonded, 2))}</span><span class="label">bonded</span></div><div class="figure"><span class="value">${stats.verdicts}</span><span class="label">verdicts</span>${stats.verdicts ? html`<div class="breakdown" role="img" aria-label=${split} title=${split}>${PASS ? html`<span class="seg pass" style="flex-grow:${PASS}"></span>` : nothing}${FAIL ? html`<span class="seg fail" style="flex-grow:${FAIL}"></span>` : nothing}${DOWN ? html`<span class="seg down" style="flex-grow:${DOWN}"></span>` : nothing}</div>` : nothing}</div><div class="figure"><span class="value">${amount(formatNativeUsdc(stats.refunded, 2))}</span><span class="label">refunded</span><span class="sub"><span>${stats.refundCount} refund${stats.refundCount === 1 ? '' : 's'}</span></span></div></section>`;
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
 * @param {string} index @param {unknown} body @param {unknown} [note] @param {boolean} [wide] @param {unknown} [id]
 */
const entry = (index, body, note = nothing, wide = false, id = nothing) => html`
  <section class="entry ${wide ? 'entry-wide' : ''}" id=${id}>
    <p class="entry-index" aria-hidden="true">${index}</p>
    <div class="entry-body">${body}</div>
    ${note === nothing ? nothing : html`<aside class="entry-note">${note}</aside>`}
  </section>`;

/**
 * The margin beside the figures, and the page's only one. Demo mode says
 * "seeded" in the head, because a number on this page that could be mistaken
 * for a real one is the worst thing it could do; live mode names no chain
 * address here — the service page's own record does that where it is read.
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
    </dl>`;
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
        <wa-button href=${MARKETPLACE_PATH} @click=${navigateOnClick(go, MARKETPLACE_PATH)}>Browse the marketplace</wa-button>
        <wa-button appearance="outlined" href=${HOW_PATH} @click=${navigateOnClick(go, HOW_PATH)}>How the loop works</wa-button>
        ${mode === 'live' ? html`<a class="cta-aside" href=${REGISTER_PATH} @click=${navigateOnClick(go, REGISTER_PATH)}>or list a service of your own</a>` : nothing}
      </p>`)}

    ${entry('01', html`
      <h2>Try it — no wallet needed</h2>
      <p>One real failure, paid and refunded end to end. Every link below is a transaction or contract that actually exists on a public testnet — click Send to walk through it, about 30 seconds, nothing to sign.</p>
      <verdikt-demo-chat .go=${go}></verdikt-demo-chat>`, html`
      <p class="note-head">Nothing new to integrate</p>
      <p class="note-line">An agent already paying x402 services uses Verdikt’s proxy API endpoint instead of the provider’s own — same challenge, same payment.</p>`, false, 'try-it')}

    ${entry('02', html`
      <h2>The record so far</h2>
      ${figuresFor(marketplace, error)}`, verdictNote(marketplace, mode, error))}

    ${entry('03', html`
      <h2>The payment is verifiable. The delivery is not.</h2>
      <p>x402 proves a call was paid for. Nothing proves it was answered. The promise lives in a README, the record of whether it was kept lives nowhere, and an arbitration queue would cost more than the call it was arguing about — so reliability stays whatever the provider says it is.</p>
      <p><strong class="brand-inline"><img src="/favicon.svg" alt="" width="22" height="22" />Verdikt</strong> deletes the claim.</p>`, html`
      <p class="note-head">Why no dispute layer</p>
      <p class="note-line">A refund is money back, never a penalty: it cannot exceed what the call cost, or what is left of the provider’s bond.</p>`)}

    ${entry('04', html`
      <h2>The request path</h2>
      <p>Two chains, one job each. Arc holds the contracts — registry, bond, verdicts, refunds — and the payment itself, since USDC is its gas token, so what was paid and what comes back are the same asset in the same place. GenLayer holds the semantic claim, on the rare call where a consumer disputes what the answer meant.</p>
      <p>Doing the judging is a Chainlink CRE Confidential Workflow. The call is replayed inside a TEE, so nobody has to be trusted with the response; it is measured against the SLA that provider published, and the verdict it writes carries a proof of the computation that produced it.</p>`, html`
      <p class="note-head">What never leaves</p>
      <p class="note-line">The observed value stays off the chain. Only the verdict is recorded there — trustlessly, because the TEE proves what computed it.</p>
      <p class="note-line">The whole loop drawn, and the same thing in prose — what happens to a 4xx, why an empty window scores 1000, and what a consumer can still dispute: <a href=${HOW_PATH} @click=${navigateOnClick(go, HOW_PATH)}>how it works</a>.</p>`)}

    ${entry('05', html`
      <div class="entry-split">
        <div class="split-col">
          <h2>Tell us what you are building</h2>
          <p>What you are pointing at this, and what you need from it. A hole in the mechanism is the most welcome message of all.</p>
          <verdikt-contact></verdikt-contact>
        </div>
        <div class="split-col">
          <h2>Be informed about our progress</h2>
          <p>One short message as each milestone lands, and nothing else.</p>
          <verdikt-subscribe></verdikt-subscribe>
          <p class="landing-social">
            <a class="cta-aside" href=${GITHUB_URL} target="_blank" rel="noopener noreferrer">Star the repository</a>
            <a class="cta-aside" href=${X_URL} target="_blank" rel="noopener noreferrer">Follow on X</a>
          </p>
        </div>
      </div>`, html`
      <p class="note-line" id="landing-forms-note">Both forms go to the form service named in the <a href=${PRIVACY_PATH} @click=${navigateOnClick(go, PRIVACY_PATH)}>privacy policy</a>, and nowhere else.</p>`, true)}
  </div>`;
