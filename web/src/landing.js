// The landing page.
//
// One continuous ruled sheet rather than a stack of marketing bands: every
// section is an entry, numbered in a mono rail on the far left and annotated in
// the outer margin, on the same hairlines the marketplace tables are set on.
// The numbering is load-bearing here — a ledger's lines are referenced by their
// index — which is the one thing that earns section numbers on a page like
// this. See web/.impeccable/surfaces/web-src-pages-js.md.
//
// Unlike pages.js, this one shows chain data: the platform figures moved here
// from the marketplace listing, and the margin of entry 00 carries the most
// recent verdict the registry has actually written. Both degrade to the chain's
// own identity while the first read is in flight, and both say "demo" out loud
// when no RPC is configured — a number on this page that could be mistaken for
// a real one is the single worst thing it could do.

import { html, nothing } from 'lit';
import { ARC } from '@verdikt/sdk';
import { formatMinorUsdc, formatNativeUsdc, shortHex } from './format.js';
import { HOW_PATH, MARKETPLACE_PATH, PROVIDER_PATH, navigateOnClick } from './router.js';
import { TAGLINE } from './pages.js';
import './diagram.js';

const GITHUB_URL = 'https://github.com/imajus/verdikt';

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
// One rule for every margin on the page: a chain address is named only where a
// chain was actually read. Demo mode names none, because printing the real
// registry under "seeded demo data, not a live chain" invites exactly the
// reading the sentence above it denies.
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

/** @param {Marketplace|null} marketplace @param {'live'|'demo'} mode @param {string|null} error */
const verdictNote = (marketplace, mode, error) => {
  const newest = newestVerdict(marketplace);
  if (!newest) {
    return html`
      <p class="note-head">Latest verdict</p>
      <p class="note-line ${error ? 'warn' : 'muted'}">${error
        ? 'The registry did not answer, so there is nothing to read back. Nothing on this page is estimated in its place.'
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
        <wa-button href=${MARKETPLACE_PATH} @click=${navigateOnClick(go, MARKETPLACE_PATH)}>Browse the marketplace</wa-button>
        <wa-button appearance="outlined" href=${HOW_PATH} @click=${navigateOnClick(go, HOW_PATH)}>How the loop works</wa-button>
        ${mode === 'live' ? html`<a class="cta-aside" href=${PROVIDER_PATH} @click=${navigateOnClick(go, PROVIDER_PATH)}>or list a service of your own</a>` : nothing}
      </p>`, verdictNote(marketplace, mode, error))}

    ${entry('01', html`
      <h2>The record so far</h2>
      ${figuresFor(marketplace, error)}`, html`
      <p class="note-head">Where these come from</p>
      <p class="note-line">${mode === 'demo'
        ? html`Seeded demo data, not a live chain — this build has no <code>VITE_ARC_RPC_URL</code>, and an empty marketplace would be indistinguishable from a broken one.`
        : html`Arc Testnet, read over public RPC by your own browser. There is no Verdikt server and no indexer between you and the registry’s events.`}</p>
      ${mode === 'live' && ARC.registry
        ? html`<p class="note-line"><code>${ARC.registry}</code>${ARC.deployBlock ? html` from block ${ARC.deployBlock}` : nothing}</p>`
        : nothing}`)}

    ${entry('02', html`
      <h2>The payment is verifiable. The delivery is not.</h2>
      <p>x402 settles a call and its price inside one request, which is the whole appeal: an agent can pay an endpoint it has never met, in one round trip, with no account. What it cannot do is prove it got what it paid for.</p>
      <p>So the promise lives in a README and the record of whether the promise was kept lives nowhere. When a response comes back late, or shaped wrong, or carrying an error under a 200, there is nothing to appeal to — the money moved, the endpoint answered, and an arbitration queue would cost more than the call it was arguing about. Marketplaces paper over this with a reputation score computed by whoever runs the marketplace: a number the provider cannot audit and the caller cannot verify.</p>
      <p>A provider has the mirror of the same problem. Its reliability is its own claim about itself, so running a genuinely dependable endpoint buys nothing that a confident landing page does not.</p>
      <p>Verdikt deletes the claim. The SLA is a text record only the provider can write, the judgement runs inside an enclave neither side controls, and the consequence is a refund drawn from a bond that was posted before the first call.</p>`, html`
      <p class="note-head">Why no dispute layer</p>
      <p class="note-line">A refund is capped at <code>min(fixed refund, what was paid, what remains of the bond)</code> — never a penalty on top. A FAIL someone manufactured is never worth more than the call it broke, which is what lets the verdict be final with nothing to appeal to.</p>`)}

    ${entry('03', html`
      <h2>The request path</h2>
      <p>Two chains, each for one reason. Arc holds the registry, the bond, the verdicts and the refunds — USDC is its native gas token, so payment and refund are the same asset on the same chain. Ethereum Sepolia holds ENS, where the SLA lives as a text record scoped per key, so the provider can write its promise and only the verification signer can write the scores.</p>
      <verdikt-diagram class="diagram"></verdikt-diagram>
      <p class="figure-source">The same loop in prose, including what happens to a 4xx and why an empty window scores 1000: <a href=${HOW_PATH} @click=${navigateOnClick(go, HOW_PATH)}>how it works</a>.</p>`, html`
      <p class="note-head">What never leaves</p>
      <p class="note-line">The observed value stays off the chain. It is a slice of a response the agent paid for, so it comes back to that agent on its own response as <code>x-verdikt-expected</code> and <code>x-verdikt-actual</code>, and to nobody else.</p>`, true)}

    ${entry('04', html`
      <h2>When the next piece lands</h2>
      <p>Three things here are deliberately unfinished, and each is argued in the open rather than hidden: a paid call carried end to end, production enrollment of the verification workflow, and the recorded walkthrough. Leave an address and you get one short message as each lands. No digest, no drip, nothing else.</p>
      <verdikt-subscribe></verdikt-subscribe>`, html`
      <p class="note-head">Already shipped</p>
      <!-- TEMPORARY (demo window): "trailing-1-day" tracks WINDOW_SECONDS in
           cre/lib/reputation.js; restore "trailing-7-day" when it goes back. -->
      <p class="note-line">The loop runs end to end on public testnets: two services bonded, verdicts written through the real KeystoneForwarder, refunds credited and withdrawn, and trailing-1-day scores published hourly to ENS.</p>`)}

    ${entry('05', html`
      <h2>Tell us what you are building</h2>
      <p>Three kinds of message are useful here: you have a service worth listing and want to know what bonding it costs; you are pointing a paying agent at somebody else’s endpoint and want the proxy in front of it; or you have found a hole in the mechanism. The third is the most welcome of the three.</p>
      <verdikt-contact></verdikt-contact>`, html`
      <p class="note-head">Or argue in public</p>
      <p class="note-line">The mechanism, the open risks and the unfinished tasks are all in the repository. <a href=${GITHUB_URL} target="_blank" rel="noopener noreferrer">imajus/verdikt</a> — an issue reaches the same person a message does, and leaves a trail.</p>`)}
  </div>`;
