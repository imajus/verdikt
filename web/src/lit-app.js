import { LitElement, html, nothing } from 'lit';
import { formatMinorRange, formatMinorUsdc, formatNativeUsdc, formatRefundUsdc, formatScore, formatWhen, scoreBand, shortHex } from './format.js';
import { getConnectedAccount } from './wallet.js';
import { getSession } from './session.js';
import { ARC, SEPOLIA } from '@verdikt/sdk';
import { WINDOW_SECONDS } from '@verdikt/cre/reputation';
import { isListed } from './marketplace.js';
import { resolveProviderConsole } from './provider.js';
import { HOW_PATH, LANDING_PATH, MARKETPLACE_PATH, PROVIDER_PATH, REGISTER_PATH, ensExplorerUrl, manageUrl, navigateOnClick, providerUrl, serviceUrl } from './router.js';
import { TAGLINE, legalFooter, pageHead, privacy, providerPrompt, terms } from './pages.js';
import { amount, landing } from './landing.js';

const GITHUB_URL = 'https://github.com/imajus/verdikt';
const X_URL = 'https://x.com/denismajus';

/** @param {(path: string) => void} go */
const brand = (go) => html`<a class="nav-brand" href=${LANDING_PATH} aria-label="Verdikt home" @click=${navigateOnClick(go, LANDING_PATH)}><img class="brand-mark" src="/favicon.svg" alt="" width="45" height="45" /><span>Verdikt</span></a>`;
const githubIcon = () => html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"></path></svg>`;
const xIcon = () => html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9.53 6.78 15.17.5h-1.34L8.94 5.87 5.02.5H0l5.92 8.15L0 15.5h1.34l5.19-5.7 4.15 5.7H16L9.53 6.78Zm-1.84 2.02-.6-.83L2.3 1.44h2.06l3.84 5.29.6.83 4.99 6.87h-2.06L7.69 8.8Z"></path></svg>`;
const sunIcon = () => html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.22 4.22l1.77 1.77M18.01 18.01l1.77 1.77M2 12h2.5M19.5 12H22M4.22 19.78l1.77-1.77M18.01 5.99l1.77-1.77"/></svg>`;
const moonIcon = () => html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>`;

/** @param {number|null} score */
const scoreCell = (score) => html`
  <span class="score ${scoreBand(score)}">
    <b>${formatScore(score)}</b>
    ${score === null ? nothing : html`<span class="meter"><span style="width:${score / 10}%"></span></span>`}
  </span>`;

// An empty window scores 1000 on both ratios, because absence of evidence is
// not evidence of failure (packages/sla/aggregate.js). That presumption is
// defensible for conformance, which is about the quality of responses that
// arrived; it is not something to render as a measurement for availability,
// which is only about whether calls were answered at all — precisely what
// nobody has tested yet. So availability reads N/A until the first verdict
// lands. This is a display decision and nothing else: the published number is
// still 1000, and `byReputation` still ranks on it.
const NO_TRAFFIC_TITLE =
  'No paid calls have been tracked for this service yet, so whether it answers has not been measured.';

/** @param {Listing} listing */
const untracked = (listing) => listing.history.length === 0;

/** @param {Listing} listing */
const availabilityCell = (listing) =>
  untracked(listing)
    ? html`<span class="score unknown" title=${NO_TRAFFIC_TITLE}><b>N/A</b></span>`
    : scoreCell(listing.published.availability);

/** @param {ServiceStatus} status */
const statusMark = (status) => html`
  <span class="state ${status.toLowerCase()}"><i class="dot"></i>${status.charAt(0)}${status.slice(1).toLowerCase()}</span>`;

/** @param {SlaOutcome} outcome */
const outcomeMark = (outcome) => html`
  <span class="outcome ${outcome.toLowerCase()}"><i class="dot"></i>${outcome}</span>`;

const listingHead = () => html`
  <div class="row head">
    <span class="cell name">Service</span>
    <span class="cell num" title="Share of responses that arrived and met the SLA">Conformance</span>
    <span class="cell num" title="Share of paid calls that returned anything usable">Availability</span>
    <span class="cell num">Bond</span>
    <span class="cell status">Status</span>
  </div>`;

/** A bound in milliseconds, read as a person would say it. @param {number} ms */
const duration = (ms) => (ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`);

/**
 * The clause as one sentence, which is the promise itself — the type is what
 * the sentence is about, so a separate Type column only restated it. A schema
 * clause has no bound worth printing; its provider-written note carries the
 * shape, and pulling the JSON Schema apart here would put schema knowledge
 * back outside `packages/sla`.
 * @param {SlaClause} clause
 */
const clausePromise = (clause) =>
  clause.type === 'latency'
    ? `Answers within ${duration(clause.maxMs)}`
    : clause.type === 'priceRange'
      ? `Priced from ${formatMinorRange(BigInt(clause.minMinorUnits), BigInt(clause.maxMinorUnits))} a call`
      : 'Matches the response schema published with this SLA';

/**
 * Anchors keyed by clause id, so a verdict can point at the clause it says
 * broke. Indexed rather than derived from the id: a clause id is
 * provider-authored and unbounded, and an `id` attribute built out of one
 * would need escaping at both the anchor and the link.
 * @param {SlaClause[]} clauses
 */
const clauseAnchors = (clauses) => new Map(clauses.map((clause, index) => [clause.id, `clause-${index}`]));

/** @param {ListingVerdict} verdict @param {Map<string, string>} anchors */
const failedClauseCell = (verdict, anchors) => {
  if (verdict.outcome === 'PASS') return html`<span class="muted">—</span>`;
  if (verdict.failedClauseId === null) return html`<span class="muted" title="Judged on status alone: no SLA was in force for this call, so no clause was evaluated.">status only</span>`;
  if (verdict.failedClauseId === 'delivery') return html`<code title="The implicit clause every service is held to: a response arrived and was not a 5xx. No provider declares it.">delivery</code>`;
  if (verdict.failedClauseId === 'unknown') return html`<span class="warn" title="This verdict names a clause the published SLA no longer declares — it has been edited since.">edited since</span>`;
  const anchor = anchors.get(verdict.failedClauseId);
  if (!anchor) return html`<code>${verdict.failedClauseId}</code>`;
  return html`<a class="clause-link" href="#${anchor}" title="The clause this call broke, as the SLA declares it above."><code>${verdict.failedClauseId}</code></a>`;
};

/**
 * The subname, linked out to the ENS explorer.
 *
 * Used wherever the name stands as the service's identifier — a listing row,
 * the service page's head, its `On the record` block, and the registration
 * docket once the subname exists. Deliberately not used where the name
 * appears inside a sentence or as a section heading's disambiguator: the same
 * outbound link four times on one page is noise, not access.
 *
 * @param {string} name
 */
const ensLink = (name) => html`<a
  class="ens-link" href=${ensExplorerUrl(name)} target="_blank" rel="noopener noreferrer"
  title=${`${name} on the ENS explorer — its owner, its resolver and every record write`}>${name}</a>`;

/** @param {Listing} listing @param {(path: string) => void} go */
const listingRow = (listing, go) => {
  const unranked = listing.published.conformance === null && listing.published.availability === null;
  const href = serviceUrl(listing.slug);
  // The row is a div with a stretched link inside it, not an `<a>` wrapping
  // everything: the subname carries its own link out to the ENS explorer, and
  // an anchor inside an anchor is not markup a browser will keep.
  return html`
    <div class="row" data-slug=${listing.slug}>
      <span class="cell name">
        <strong><a class="row-link" href=${href} @click=${navigateOnClick(go, href)}>${listing.slug}</a></strong>
        <small>${ensLink(listing.name)}</small>
        ${listing.contested ? html`<span class="contested">contested</span>` : nothing}
        ${unranked ? html`<span class="unranked">not yet ranked</span>` : nothing}
      </span>
      <span class="cell num">${scoreCell(listing.published.conformance)}</span>
      <span class="cell num">${availabilityCell(listing)}</span>
      <span class="cell num">${amount(formatNativeUsdc(listing.deposit, 2))}</span>
      <span class="cell status">${statusMark(listing.status)}</span>
    </div>`;
};

/**
 * A footnote, as a mark you can ask rather than a paragraph you must read
 * past. The rules it carries — how a refund is capped, which window the
 * published ratios cover — are permanent background: true of every service on
 * every reading, and so the fourth time down the marketplace they are furniture
 * standing between a reader and the numbers they came for.
 *
 * The icon is drawn, not a `?` character: a glyph standing in for an icon is
 * the one thing this system's icon rule names outright.
 *
 * @param {string} id shared with the `wa-tooltip` that anchors to it
 * @param {string} label the button's own name, for when the tooltip has not upgraded
 */
const helpButton = (id, label) => html`<button type="button" class="help" id=${id} aria-label=${label}>
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.25"/><path d="M9.1 9.3a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17.02h.01"/></svg>
</button>`;

/** @param {string} id @param {string} placement @param {unknown} content */
const helpTip = (id, placement, content) => html`<wa-tooltip class="help-tip" for=${id} placement=${placement} trigger="hover focus click">${content}</wa-tooltip>`;

const copyIcon = () => html`<svg class="icon-copy" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="1"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-9A1.5 1.5 0 0 0 3 5.5v9A1.5 1.5 0 0 0 4.5 16"/></svg>`;
const checkIcon = () => html`<svg class="icon-check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12.5 5.5 5.5L20 6"/></svg>`;

/**
 * Writes `value` to the clipboard and reports back on the button itself.
 *
 * The label is set directly rather than through a re-render: `detailTemplate`
 * is a pure function of the listing, and nothing about the listing changed.
 * A later render of the same template resets the button to its idle label,
 * which is the state it should be in by then anyway.
 *
 * @param {string} value
 */
const copyOnClick = (value) => async (/** @type {Event} */ event) => {
  const button = /** @type {HTMLButtonElement} */ (event.currentTarget);
  const label = button.querySelector('.copy-label');
  if (!label) return;
  // A failure here means no clipboard permission, or no clipboard at all over
  // plain http. Say so rather than claiming a copy that did not happen — the
  // URL beside the button is selectable, so there is still a way through.
  let copied;
  try {
    await navigator.clipboard.writeText(value);
    copied = true;
  } catch {
    copied = false;
  }
  button.dataset.state = copied ? 'copied' : 'failed';
  label.textContent = copied ? 'Copied' : 'Select it';
  window.setTimeout(() => {
    button.dataset.state = 'idle';
    label.textContent = 'Copy';
  }, 2000);
};

/**
 * A formatted amount with its asset quieted, for a figure that may be a range.
 *
 * `amount()` splits on the first space and keeps two pieces, which is right
 * for "0.001 USDC" and wrong for "0.000001 to 2.5 USDC" — it kept "0.000001"
 * and rendered "to" as the unit, dropping the top of the range entirely.
 * @param {string} text
 */
const figure = (text) => {
  const cut = text.lastIndexOf(' ');
  return cut === -1 ? html`${text}` : html`${text.slice(0, cut)}<small>${text.slice(cut + 1)}</small>`;
};

/** @param {string} value */
const copyButton = (value) => html`
  <button type="button" class="copy" data-state="idle" aria-label="Copy ${value}" @click=${copyOnClick(value)}>
    ${copyIcon()}${checkIcon()}<span class="copy-label" aria-live="polite">Copy</span>
  </button>`;

/**
 * Why the proxy will not route this slug, or `null` when it will.
 *
 * Both conditions are already stated elsewhere on the page, but they belong
 * beside the endpoint: what they invalidate is the call, not the record.
 * @param {Listing} listing
 */
const routingBlock = (listing) => {
  if (listing.status === 'DEREGISTERED') {
    return html`This service was retired by its provider: the bond was returned, the route answers <code>503</code>, and the slug can never be registered again. The verdicts below are its closed record.`;
  }
  if (listing.status === 'SUSPENDED') {
    return html`Refunds have drained this service’s bond, so the route answers <code>503</code> until the provider tops it up. A bond is what a refund is paid from; without one there is nothing behind the promise.`;
  }
  if (listing.contested) {
    return html`This slug’s ENS subname and its Arc registration are owned by different addresses. The proxy refuses to route it until they agree — see <a href=${HOW_PATH}>how it works</a>.`;
  }
  return null;
};

/**
 * What a call to this service has cost, read off the ledger below rather than
 * asserted. The 402 challenge is the authority on the current price and this
 * page never fetches one, so the honest claim is the observed one — and when
 * nothing has been called yet there is no claim to make at all.
 *
 * @param {Listing} listing
 */
const observedPrice = (listing) => {
  const paid = listing.history.map((verdict) => verdict.paidAmount);
  if (paid.length === 0) return null;
  const low = paid.reduce((a, b) => (b < a ? b : a));
  const high = paid.reduce((a, b) => (b > a ? b : a));
  const calls = `${paid.length} recorded call${paid.length === 1 ? '' : 's'}`;
  return {
    low,
    high,
    figure: low === high ? formatMinorUsdc(low) : formatMinorRange(low, high),
    note:
      low === high
        ? `What ${paid.length === 1 ? 'the one recorded call' : `all ${calls}`} paid.`
        : `The range across ${calls}.`
  };
};

/** @param {Listing} listing @param {SlaClause[]} clauses */
const callSection = (listing, clauses) => {
  const url = `https://${listing.slug}.verdikt.bond`;
  const blocked = routingBlock(listing);
  const price = observedPrice(listing);
  const band = /** @type {SlaPriceRangeClause|undefined} */ (clauses.find((clause) => clause.type === 'priceRange'));
  const bandText = band ? formatMinorRange(BigInt(band.minMinorUnits), BigInt(band.maxMinorUnits)) : null;
  // Whether the observed figures actually sit inside the declared band, not
  // whether a band exists. `weather`'s ledger runs from 1 minor unit to 2.5
  // USDC against a clause promising 0.000001 to 0.01, and saying "inside the
  // band" over that would be the page asserting something its own table
  // disproves two sections down.
  const withinBand = Boolean(
    band && price && price.low >= BigInt(band.minMinorUnits) && price.high <= BigInt(band.maxMinorUnits)
  );
  return html`
    <section class="block call">
      <h3>Call it</h3>
      <p class="endpoint ${blocked ? 'off' : ''}">
        <code class="endpoint-url">${url}</code>
        ${blocked ? nothing : copyButton(url)}
      </p>
      ${blocked ? html`<p class="aside warn">${blocked}</p>` : nothing}
      ${price
        ? html`<p class="price"><b>${figure(price.figure)}</b><span class="price-unit">a call</span>
            <span class="price-note">${price.note}${bandText
              ? withinBand
                ? html` Inside the ${bandText} band its price clause promises.`
                : html` Its price clause promises ${bandText} a call.`
              : nothing}</span></p>`
        : html`<p class="call-note">Nothing has been called yet, so this page has no price to report.${bandText ? html` Its price clause promises ${bandText} a call; the 402 challenge names the figure you would actually sign for.` : nothing}</p>`}
      ${blocked
        ? nothing
        : html`<p class="call-note">Append a path or query and it is forwarded to <code>${listing.endpoint ?? 'the registered endpoint'}</code>. The first call answers <code>402</code> with the provider’s own challenge; pay it and the response is judged against the clauses below, inside the enclave, before it reaches you — <a href=${HOW_PATH}>how that works</a>.</p>`}
    </section>`;
};

/** @param {Listing} listing @param {SlaClause[]} clauses @param {Map<string, string>} anchors */
const promisedSection = (listing, clauses, anchors) => html`
  <section class="block">
    <h3>What it promised <small>${clauses.length ? `${clauses.length} clause${clauses.length === 1 ? '' : 's'}` : ''}</small></h3>
    ${clauses.length === 0
      ? html`<p class="aside">${listing.slaRaw ? 'The published SLA does not parse, so every call falls back to status-only judging: 2xx passes, 5xx fails, anything else writes no verdict.' : 'No SLA published. Every call falls back to status-only judging.'}</p>`
      : html`<ol class="clauses">
          ${clauses.map((clause) => html`
            <li class="clause" id=${anchors.get(clause.id) ?? nothing}>
              <div class="clause-body">
                <p class="clause-promise">${clausePromise(clause)}</p>
                ${/** @type {{description?: string}} */ (clause).description
                  ? html`<p class="clause-note">${/** @type {{description?: string}} */ (clause).description}</p>`
                  : nothing}
              </div>
              <p class="clause-key"><span class="note-head">${clause.type}</span><code>${clause.id}</code></p>
            </li>`)}
        </ol>`}
  </section>`;

/** @param {Listing} listing @param {Map<string, string>} anchors */
const deliveredSection = (listing, anchors) => {
  const counts = { PASS: 0, FAIL: 0, DOWN: 0 };
  for (const verdict of listing.history) counts[verdict.outcome] += 1;
  const tally = /** @type {SlaOutcome[]} */ (['PASS', 'FAIL', 'DOWN'])
    .filter((outcome) => counts[outcome] > 0)
    .map((outcome) => html`<span class=${outcome.toLowerCase()}><i class="dot"></i>${counts[outcome]} ${outcome}</span>`);
  return html`
    <section class="block">
      <h3>What it delivered <small class="tally">${listing.history.length === 0 ? 'no calls yet' : tally}</small>
        ${listing.history.length === 0 ? nothing : helpButton('delivered-help', 'How a refund is sized and paid')}</h3>
      ${listing.history.length === 0 ? nothing : helpTip('delivered-help', 'bottom-start', html`A FAIL or DOWN credits the payer from this service’s bond, capped at what they actually paid — never a penalty on top. The credit is booked, not sent: the agent calls <code>withdraw()</code> to collect it.`)}
      ${listing.history.length === 0
        ? html`<p class="aside">No paid calls yet. A service nobody has called is presumed healthy, which is why its conformance reads 100% rather than 0 — but nothing has been observed about whether it answers, so availability reads N/A until the first verdict lands.</p>`
        : html`
          <p class="strip-row">
            <span class="strip" role="img" aria-label=${`${listing.history.length} verdicts, oldest first: ${tally.length ? `${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.DOWN} DOWN` : ''}`}>${[...listing.history].reverse().map((verdict) => html`<i class=${verdict.outcome.toLowerCase()} title=${`${verdict.outcome}${verdict.blockNumber === null ? '' : ` · block ${verdict.blockNumber}`}`}></i>`)}</span>
            <span class="strip-note">oldest first</span>
          </p>
          <div class="scroll"><table class="ledger"><thead><tr><th>Outcome</th><th>Broke</th><th class="num">Paid</th><th class="num">Refunded</th><th class="edge">Request</th><th>Payer</th><th class="num">Block</th></tr></thead><tbody>
            ${listing.history.map((verdict) => html`<tr class="verdict ${verdict.outcome.toLowerCase()}"><td>${outcomeMark(verdict.outcome)}</td><td>${failedClauseCell(verdict, anchors)}</td><td class="num">${figure(formatMinorUsdc(verdict.paidAmount))}</td><td class="num">${verdict.refunded > 0n ? figure(formatRefundUsdc(verdict.refunded)) : html`<span class="muted">—</span>`}</td><td class="edge"><code title=${verdict.requestId}>${shortHex(verdict.requestId)}</code></td><td><code title=${verdict.payer}>${shortHex(verdict.payer)}</code></td><td class="num muted">${verdict.blockNumber ?? '—'}</td></tr>`)}
          </tbody></table></div>`}
    </section>`;
};

/**
 * Where every figure above came from, so any of it can be checked without
 * this page. It is also where the two records that do not belong at the top
 * ended up: the upstream URL a caller never types, and the `address` record —
 * which is published by the provider and, since issue #37 removed the payTo
 * check, is not what the proxy routes on.
 *
 * @param {Listing} listing @param {'live'|'demo'} mode @param {(path: string) => void} go
 */
const recordSection = (listing, mode, go) => {
  const consolePath = providerUrl(listing.provider);
  return html`
    <section class="block record">
      <h3>On the record</h3>
      <table class="kv">
        <tr><th>Relays to</th><td>${listing.endpoint ? html`<code>${listing.endpoint}</code>` : html`<span class="muted">no <code>url</code> record published</span>`}</td></tr>
        <tr><th>Subname</th><td><code>${ensLink(listing.name)}</code> <span class="muted">on Ethereum Sepolia</span></td></tr>
        <tr><th>Address record</th><td>${listing.payTo ? html`<code>${listing.payTo}</code>` : html`<span class="muted">none published</span>`}</td></tr>
        <tr><th>Provider</th><td><a href=${consolePath} @click=${navigateOnClick(go, consolePath)}><code>${listing.provider}</code></a></td></tr>
        <tr><th>Service id</th><td><code>${listing.serviceId}</code></td></tr>
        ${mode === 'live' ? html`<tr><th>Registry</th><td><code>${ARC.registry}</code> <span class="muted">on Arc Testnet</span></td></tr>` : nothing}
      </table>
      <p class="aside">The proxy’s trust anchor is the <code>url</code> record, bound to the bond by the subname’s owner and the Arc provider being the same address. The <code>address</code> record is the provider’s own declaration and is not checked against the 402 challenge.</p>
    </section>`;
};

/** @param {Listing|null} listing @param {'live'|'demo'} [mode] @param {(path: string) => void} [go] */
export const detailTemplate = (listing, mode = 'live', go = () => {}) => {
  if (!listing) return html`<p class="empty">Pick a service to see what it promised and what it delivered.</p>`;
  const clauses = listing.sla?.clauses ?? [];
  const anchors = clauseAnchors(clauses);
  const unpublished = listing.published.conformance === null;
  const refunded = listing.history.reduce((total, verdict) => total + verdict.refunded, 0n);
  const days = Math.round(WINDOW_SECONDS / 86400);
  return html`
    <header class="detail-head">
      <div><h2>${listing.slug}</h2><p class="sub"><code>${ensLink(listing.name)}</code> ${statusMark(listing.status)}</p></div>
      <div class="scores-group">
        <dl class="scores">
          <div><dt>Conformance</dt><dd>${scoreCell(listing.published.conformance)}</dd></div>
          <div><dt>Availability</dt><dd>${availabilityCell(listing)}</dd></div>
          <div><dt>Bond</dt><dd>${figure(formatNativeUsdc(listing.deposit))}</dd>
            ${refunded > 0n ? html`<dd class="score-note">${formatRefundUsdc(refunded)} refunded out</dd>` : nothing}</div>
        </dl>
        ${unpublished ? nothing : helpButton('scores-help', 'What these figures are and where they come from')}
      </div>
    </header>
    ${unpublished ? nothing : helpTip('scores-help', 'bottom-end', html`Conformance and availability are the trailing ${days}-day ratios the hourly workflow publishes on <code>${listing.name}</code>; the marketplace ranks on those, not on anything computed in this page.${untracked(listing) ? html` Availability reads N/A rather than the published figure until the first verdict lands — whether this service answers has not been measured yet.` : nothing} The bond is held on Arc and is what a refund is paid from.`)}
    ${listing.namingLayer === 'unreachable'
      ? html`<p class="aside warn">The naming layer did not answer, so this service’s SLA and scores could not be read. Its bond and verdict history are on Arc and are shown.</p>`
      : unpublished
        // A standing note, not a provenance line: "why is this blank" is the
        // reader's live question, and answering it in grey under the figures
        // buries it. Reachable-but-unwritten only — when Sepolia is the thing
        // that failed, the hourly run may well have written this subname and
        // the warning above is the honest account of why it is not shown.
        ? html`<p class="aside">No scores published yet — the hourly run has not written this subname. Over the verdicts below the same computation gives ${formatScore(listing.unpublished.conformance)} conformance and ${untracked(listing) ? 'N/A' : formatScore(listing.unpublished.availability)} availability, but the marketplace ranks on what is published, not on this.</p>`
        : nothing}
    ${callSection(listing, clauses)}
    ${promisedSection(listing, clauses, anchors)}
    ${deliveredSection(listing, anchors)}
    ${recordSection(listing, mode, go)}`;
};

/** @param {'landing'|'marketplace'|'service'|'manage'|'provider'|'register'|'how'|'terms'|'privacy'} view @param {'live'|'demo'} mode @param {'light'|'dark'} theme @param {string|null} account @param {(path: string) => void} go @param {() => void} connect @param {() => void} disconnect @param {(theme: 'light'|'dark') => void} changeTheme */
const nav = (view, mode, theme, account, go, connect, disconnect, changeTheme) => {
  /** @param {string} path @param {string} label @param {string} activeView */
  const item = (path, label, activeView) => {
    const active = view === activeView || (activeView === 'marketplace' && view === 'service');
    return html`<a href=${path} class="nav-item ${active ? 'active' : ''}" data-nav=${activeView} @click=${navigateOnClick(go, path)}>${label}</a>`;
  };
  const themeToggle = html`<button type="button" class="theme-toggle" aria-label=${theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'} @click=${() => changeTheme(theme === 'light' ? 'dark' : 'light')}>${theme === 'light' ? sunIcon() : moonIcon()}</button>`;
  /** @param {CustomEvent<{ item: { value: string } }>} event */
  const selectWalletAction = (event) => {
    if (event.detail.item.value === 'change') connect();
    if (event.detail.item.value === 'disconnect') disconnect();
  };
  const wallet = mode === 'live'
    ? account
      ? html`<wa-dropdown class="wallet-menu" placement="bottom-end" size="s" @wa-select=${selectWalletAction}>
          <wa-button slot="trigger" class="nav-account" appearance="outlined" size="s" with-caret title=${account} aria-label="Wallet menu for ${account}">${account.slice(0, 6)}…${account.slice(-4)}</wa-button>
          <div class="wallet-menu-heading"><span>Connected wallet</span><code>${account}</code></div>
          <wa-divider></wa-divider>
          <wa-dropdown-item value="change"><svg slot="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/></svg>Change wallet</wa-dropdown-item>
          <wa-dropdown-item value="disconnect" variant="danger"><svg slot="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M9 4H4v16h5m5-13 5 5-5 5M9 12h10"/></svg>Disconnect</wa-dropdown-item>
        </wa-dropdown>`
      : html`<wa-button type="button" appearance="outlined" size="s" @click=${connect}>Connect wallet</wa-button>`
    : nothing;
  // Points at the connected address's own console when there is one — the
  // bare path renders a prompt, not somebody's data, so leaving it static
  // would cost a connected provider a second click for nothing.
  const providerPath = account ? providerUrl(account) : PROVIDER_PATH;
  return html`<nav class="nav">${brand(go)}<div class="nav-links">${item(MARKETPLACE_PATH, 'Marketplace', 'marketplace')}${mode === 'live' ? item(providerPath, 'Provider', 'provider') : nothing}${item(HOW_PATH, 'How it works', 'how')}</div><div class="nav-external">${themeToggle}<a href=${GITHUB_URL} target="_blank" rel="noopener noreferrer" aria-label="Verdikt on GitHub">${githubIcon()}</a><a href=${X_URL} target="_blank" rel="noopener noreferrer" aria-label="Verdikt on X">${xIcon()}</a>${wallet}</div></nav>`;
};

/** @param {string} width */
const bar = (width) => html`<span class="bar" style="width:${width}"></span>`;

/** @param {string} nameWidth */
const skeletonRow = (nameWidth) => html`
  <div class="row skeleton">
    <span class="cell name">${bar(nameWidth)}</span>
    <span class="cell num">${bar('2.2rem')}</span>
    <span class="cell num">${bar('2.2rem')}</span>
    <span class="cell num">${bar('2.6rem')}</span>
    <span class="cell status">${bar('3rem')}</span>
  </div>`;

const SKELETON_ROW_WIDTHS = ['72%', '58%', '85%', '64%', '50%', '78%'];

// Shaped like renderMarketplace(), not a generic spinner: the same page head
// and listing grid the real page fills in, so nothing shifts when the data
// arrives. Redacted rather than shimmered, to match the ledger's own
// vocabulary of hairline rules and monospace rather than boxed cards. No
// figures row — the marketplace itself doesn't show one any more.
const skeleton = () => html`
  <div aria-hidden="true">
    ${pageHead('Marketplace', TAGLINE)}
    <section class="listing flush">${listingHead()}${SKELETON_ROW_WIDTHS.map(skeletonRow)}</section>
  </div>
  <p class="visually-hidden" role="status">Loading the marketplace…</p>`;

const how = () => html`
  <!-- TEMPORARY (demo window): the "trailing one-day scores" below tracks
       WINDOW_SECONDS in cre/lib/reputation.js. Restore "seven-day" when that
       constant does. The marketplace footer derives its own wording from
       stats.windowSeconds and needs no edit. -->
  ${pageHead('How it works', 'How the verification loop works, end to end.')}
  <section class="block"><h3>Two chains, each for one reason</h3><p><strong>Arc</strong> holds the registry, the escrow, the verdicts and the refunds — and the x402 payment itself. USDC is Arc's native gas token, so value moves as <code>msg.value</code>, not an ERC-20 transfer: no <code>approve</code>/<code>transferFrom</code>, no token address. Payment, bond and refund are the same asset on the same chain, which removes any cross-chain correlation between payment and refund.</p><p><strong>Ethereum Sepolia</strong> holds ENS. The SLA lives only as the <code>sla</code> text record on <code>&lt;slug&gt;.verdikt.eth</code>. A per-key access list scopes the provider to <code>sla</code> and <code>url</code>, and the CRE signer to <code>conformance</code> and <code>availability</code>.</p></section>
  <section class="block"><h3>What happens on a paid call</h3><p>A proxy sits between the paying agent and the provider's x402 endpoint. Without a payment header, it checks that the challenge's payout address matches ENS. With payment attached, the call is replayed inside a Chainlink CRE Confidential Workflow and evaluated against the provider's published SLA without exposing the raw response outside the enclave.</p><p>The workflow writes PASS, FAIL or DOWN on Arc. A FAIL or DOWN credits the payer from the service's bond, capped at <code>min(fixed refund, what was actually paid, what remains of the bond)</code>.</p></section>
  <section class="block"><h3>Why there is no dispute layer</h3><p>A verdict is final by design. The refund cap keeps a false FAIL from being worth manufacturing, and the observed value never goes on-chain. The clause, refund and trailing one-day scores remain public on Arc and ENS.</p></section>`;

export class VerdiktApp extends LitElement {
  static properties = { marketplace: { attribute: false }, mode: {}, route: { attribute: false }, error: {}, theme: {}, signInPending: { state: true }, signInError: { state: true } };
  constructor() {
    super();
    this.signInPending = false;
    /** @type {string|null} */ this.signInError = null;
    /** @type {Marketplace|null} */ this.marketplace = null;
    /** @type {'live'|'demo'} */ this.mode = 'demo';
    /** @type {string|null} */ this.error = null;
    /** @type {'light'|'dark'} */ this.theme = 'light';
    /** @type {{view: 'landing'|'marketplace'|'service'|'manage'|'provider'|'register'|'how'|'terms'|'privacy', slug: string|null, address: string|null, rejected?: string|null}} */
    this.route = { view: 'landing', slug: null, address: null, rejected: null };
  }
  createRenderRoot() { return this; }
  /** @param {string} path */
  go(path) { this.dispatchEvent(new CustomEvent('navigate', { detail: path })); }
  connect() { this.dispatchEvent(new CustomEvent('wallet-connect')); }
  disconnect() { this.dispatchEvent(new CustomEvent('wallet-disconnect')); }
  signIn() { this.dispatchEvent(new CustomEvent('provider-sign-in')); }
  /** @param {'light'|'dark'} theme */
  changeTheme(theme) { this.dispatchEvent(new CustomEvent('theme-select', { detail: theme })); }
  /**
   * Whether the connected wallet may write against `providerAddress`, and
   * why not when it can't. Shared by renderProvider, renderService and
   * renderRegister — a provider's own service page and the registration
   * wizard gate on the exact same four facts a provider console did before
   * this address moved off it.
   * @param {string|null} providerAddress
   */
  writeAuthorization(providerAddress) {
    const account = getConnectedAccount();
    const ownPage = Boolean(providerAddress && account?.address.toLowerCase() === providerAddress.toLowerCase());
    const supported = Boolean(account) && [ARC.chainId, SEPOLIA.chainId].includes(/** @type {{chainId: number}} */ (account).chainId);
    // `ownPage &&` first keeps getSession() — and localStorage — out of the
    // server-side render used by the tests.
    const signedIn = ownPage && getSession()?.address.toLowerCase() === account?.address.toLowerCase();
    const canWrite = Boolean(signedIn && supported);
    return { ownPage, signedIn, supported, canWrite };
  }
  /** @param {Listing[]} owned @param {string} provider @param {(path: string) => void} go */
  renderProvider(owned, provider, go) {
    const auth = this.writeAuthorization(provider);
    const bonded = owned.reduce((total, listing) => total + listing.deposit, 0n);
    const refunded = owned.reduce((total, listing) => total + listing.history.reduce((sum, verdict) => sum + verdict.refunded, 0n), 0n);
    const verdicts = owned.reduce((total, listing) => total + listing.history.length, 0);
    return html`<header class="page-head"><div><p class="tagline">Provider <code>${provider}</code> · <a href=${MARKETPLACE_PATH} @click=${navigateOnClick(go, MARKETPLACE_PATH)}>back to the marketplace</a></p></div><div class="head-actions"><p class="source">${owned.length} service${owned.length === 1 ? '' : 's'}</p>${auth.signedIn ? html`<wa-button size="s" href=${REGISTER_PATH} @click=${navigateOnClick(go, REGISTER_PATH)}>Add a service</wa-button>` : nothing}</div></header>
      ${auth.ownPage && (!auth.signedIn || !auth.supported) ? html`<div class="aside"><p>${auth.signedIn ? 'Switch to a supported network to manage your services.' : 'Sign in once to manage your services. Your sign-in lasts 24 hours in this browser.'}</p><wa-button size="s" appearance="outlined" ?disabled=${this.signInPending} ?loading=${this.signInPending} @click=${this.signIn}>${auth.signedIn ? 'Switch network' : 'Enable provider actions'}</wa-button>${this.signInError ? html`<p role="status">${this.signInError}</p>` : nothing}</div>` : nothing}
      <section class="figures"><div class="figure"><span class="value">${owned.length}</span><span class="label">services</span></div><div class="figure"><span class="value">${amount(formatNativeUsdc(bonded, 2))}</span><span class="label">bonded</span></div><div class="figure"><span class="value ${refunded > 0n ? 'fail' : ''}">${amount(formatNativeUsdc(refunded, 2))}</span><span class="label">${auth.ownPage ? 'refunded from your bonds' : 'refunded from these bonds'}</span></div><div class="figure"><span class="value">${verdicts}</span><span class="label">verdicts</span></div></section>
      ${owned.length === 0 ? html`<p class="empty">No services registered by this address.</p>` : html`<section class="listing">${listingHead()}${owned.map((listing) => listingRow(listing, go))}</section>`}`;
  }
  /** @param {PlatformStats} stats @param {Listing[]} services @param {(path: string) => void} go */
  renderMarketplace(stats, services, go) {
    // Retired services are dropped here rather than in loadMarketplace: they
    // stay in `marketplace.services` so their own page and their provider's
    // console still find them by slug. See isListed (marketplace.js).
    const listed = services.filter(isListed);
    return html`${pageHead('Marketplace', TAGLINE, html`<p class="source ${this.mode}"><i class="dot"></i>${this.mode === 'demo' ? 'demo data' : 'Arc Testnet'}</p>`)}
      ${this.mode === 'demo' ? html`<p class="aside warn">Showing seeded data, not a live chain. Set <code>VITE_ARC_RPC_URL</code> to read Arc directly.</p>` : nothing}
      <section class="listing flush">${listingHead()}${listed.length ? listed.map((listing) => listingRow(listing, go)) : html`<p class="empty">No services registered yet.</p>`}</section>
      <footer>Scores are the trailing ${Math.round(stats.windowSeconds / 86400)}-day ratios published on <code>&lt;slug&gt;.verdikt.eth</code>, recomputed hourly. Per-call verdicts are Arc events. A verdict is final: there is no dispute layer, by design. As of ${formatWhen(Math.floor(Date.now() / 1000))} UTC${listed.length ? html` · <a href=${providerUrl(listed[0].provider)} @click=${navigateOnClick(go, providerUrl(listed[0].provider))}>provider view</a>` : nothing}</footer>`;
  }
  /** @param {Listing[]} services @param {string} slug @param {(path: string) => void} go */
  renderService(services, slug, go) {
    const listing = services.find((service) => service.slug === slug) ?? null;
    if (!listing) return html`<p class="back"><a href=${MARKETPLACE_PATH} @click=${navigateOnClick(go, MARKETPLACE_PATH)}>← back to the marketplace</a></p><p class="empty">No service found for “${slug}”.</p>`;
    // The service page is public and read-only. Its owner gets one way in to
    // the controls, and nobody else sees that there are any.
    const owner = this.writeAuthorization(listing.provider).ownPage;
    return html`<p class="back ${owner ? 'with-action' : ''}"><a href=${MARKETPLACE_PATH} @click=${navigateOnClick(go, MARKETPLACE_PATH)}>← back to the marketplace</a>${owner ? html`<wa-button size="s" id="manage-service" href=${manageUrl(listing.slug)} @click=${navigateOnClick(go, manageUrl(listing.slug))}>Manage service</wa-button>` : nothing}</p>
      ${this.mode === 'demo' ? html`<p class="aside warn">Showing seeded data, not a live chain. Set <code>VITE_ARC_RPC_URL</code> to read Arc directly.</p>` : nothing}${detailTemplate(listing, this.mode, go)}`;
  }
  /**
   * The owner's console for one service. Anyone can open the URL; what it
   * shows is decided here in the same steps main.js's mount side takes
   * (providerAuthorization), so a section never renders without a mount
   * behind it. The SLA editor and bond controls exist only on this page.
   * @param {Listing[]} services @param {string} slug @param {(path: string) => void} go
   */
  renderManage(services, slug, go) {
    const listing = services.find((service) => service.slug === slug) ?? null;
    const backPath = listing ? serviceUrl(slug) : MARKETPLACE_PATH;
    const back = html`<p class="back"><a href=${backPath} @click=${navigateOnClick(go, backPath)}>← back to ${listing ? listing.slug : 'the marketplace'}</a></p>`;
    if (!listing) return html`${back}<p class="empty">No service found for “${slug}”.</p>`;
    const auth = this.writeAuthorization(listing.provider);
    const head = pageHead(`Manage ${listing.slug}`, html`Publish the SLA every call to <code>${listing.name}</code> is judged against, and keep the bond its refunds are drawn from. Each change is a transaction you sign yourself.`);
    if (this.mode === 'demo') return html`${back}${head}<p class="aside warn">Showing seeded data, not a live chain. A service is managed against Arc and Sepolia directly; set <code>VITE_ARC_RPC_URL</code>.</p>`;
    if (!auth.ownPage) return html`${back}${head}<p class="aside">Only the wallet that registered this service can manage it — provider <code>${listing.provider}</code>. ${getConnectedAccount() ? 'The connected wallet is a different address.' : 'Connect that wallet to continue.'}</p>`;
    if (!auth.signedIn || !auth.supported) return html`${back}${head}<div class="aside"><p>${auth.signedIn ? 'Switch to a supported network to manage this service.' : 'Sign in once to manage your services. Your sign-in lasts 24 hours in this browser.'}</p><wa-button size="s" appearance="outlined" ?disabled=${this.signInPending} ?loading=${this.signInPending} @click=${this.signIn}>${auth.signedIn ? 'Switch network' : 'Enable provider actions'}</wa-button>${this.signInError ? html`<p role="status">${this.signInError}</p>` : nothing}</div>`;
    return html`${back}${head}
      <section class="editor block"><h3>SLA <small>${listing.name}</small></h3><p class="aside">Validated against the same <code>schema.json</code> the verifier enforces. Sent from your own wallet; Verdikt holds no key of yours.</p><verdikt-sla-editor id="sla-editor-mount"></verdikt-sla-editor></section>
      <section class="block"><h3>Bond <small>${listing.name}</small></h3><verdikt-bond-controls id="bond-controls-mount"></verdikt-bond-controls></section>`;
  }
  /** @param {(path: string) => void} go */
  renderRegister(go) {
    const account = getConnectedAccount();
    const auth = this.writeAuthorization(account?.address ?? null);
    const consoleUrl = account ? providerUrl(account.address) : PROVIDER_PATH;
    // The way out comes before the heading, the same as the service page's
    // own back link — a way out that sits under the title reads as the first
    // step of the page rather than as the way off it.
    return html`<p class="back"><a href=${consoleUrl} @click=${navigateOnClick(go, consoleUrl)}>← back to your console</a></p>
      ${pageHead('List a service', 'Claim the ENS subname, register the bond and publish the SLA that calls will be judged against.')}
      ${this.mode !== 'live' ? html`<p class="aside warn">Registration needs a live chain. This build is showing seeded demo data.</p>` : nothing}
      <section class="block">
        ${!account
          ? html`<p>Connect a wallet to register a service.${this.mode === 'live' ? '' : ' Provider consoles read Arc Testnet; this build is showing seeded demo data.'}</p>${this.mode === 'live' ? html`<wa-button type="button" appearance="outlined" size="s" @click=${this.connect}>Connect wallet</wa-button>` : nothing}`
          : !auth.canWrite
            ? html`<p>${auth.signedIn ? 'Switch to a supported network to register a service.' : 'Sign in once to register a service. Your sign-in lasts 24 hours in this browser.'}</p><wa-button size="s" appearance="outlined" ?disabled=${this.signInPending} ?loading=${this.signInPending} @click=${this.signIn}>${auth.signedIn ? 'Switch network' : 'Enable provider actions'}</wa-button>${this.signInError ? html`<p role="status">${this.signInError}</p>` : nothing}`
            : html`<verdikt-wizard id="wizard-mount"></verdikt-wizard>`}
      </section>`;
  }
  render() {
    /** @type {(path: string) => void} */
    const go = (path) => this.go(path);
    const account = getConnectedAccount()?.address ?? null;
    const navBar = nav(this.route.view, this.mode, this.theme, account, go, () => this.connect(), () => this.disconnect(), (theme) => this.changeTheme(theme));
    // These views need no chain data, so they render even when the
    // marketplace failed to load — a dead RPC must not also strand a visitor
    // on a page with no navigation and no way to reach the legal pages.
    // The landing page reads the marketplace but does not need it: its figures
    // and its latest-verdict margin both have a shape for "not in yet".
    if (this.route.view === 'landing') return html`${navBar}${landing(go, this.marketplace, this.mode, this.error)}${legalFooter(go)}`;
    if (this.route.view === 'terms') return html`${navBar}${terms()}${legalFooter(go)}`;
    if (this.route.view === 'privacy') return html`${navBar}${privacy()}${legalFooter(go)}`;
    // A provider page with no address in it selects nobody, so there is
    // nothing to read off a chain either.
    if (this.route.view === 'provider' && !this.route.address) {
      return html`${navBar}${providerPrompt(this.mode, account, this.route.rejected ?? null, () => this.connect(), go)}${legalFooter(go)}`;
    }
    // /register needs no listing to be itself — like landing/terms/privacy,
    // it must survive a dead RPC or a marketplace still in flight.
    if (this.route.view === 'register') {
      return html`${navBar}${this.renderRegister(go)}${legalFooter(go)}`;
    }
    if (this.error) return html`${navBar}<p class="note warn">Could not load the marketplace: ${this.error}</p>${legalFooter(go)}`;
    if (!this.marketplace) return html`${navBar}${skeleton()}${legalFooter(go)}`;
    const { services, stats } = this.marketplace;
    const body = this.route.view === 'how'
      ? how()
      : this.route.view === 'service'
        ? this.renderService(services, /** @type {string} */ (this.route.slug), go)
        : this.route.view === 'manage'
          ? this.renderManage(services, /** @type {string} */ (this.route.slug), go)
        : this.route.view === 'provider'
          ? this.renderProvider(resolveProviderConsole(services, this.route.address).owned, /** @type {string} */ (this.route.address), go)
          : this.renderMarketplace(stats, services, go);
    return html`${navBar}${body}${legalFooter(go)}`;
  }
}

if (!customElements.get('verdikt-app')) customElements.define('verdikt-app', VerdiktApp);
