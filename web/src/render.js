// DOM rendering. No framework: the whole surface is a list, a detail panel and
// a row of figures, and a framework would be the largest dependency in the repo
// for markup that fits in one file.

import { formatMinorUsdc, formatNativeUsdc, formatScore, formatWhen, scoreBand, shortHex } from './format.js';
import { renderNav } from './nav.js';
import { renderHowItWorks } from './views/how-it-works.js';
import { getConnectedAccount } from './wallet.js';

/** @param {unknown} value */
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character
  );

/**
 * An amount with its unit set small, so the figure reads first.
 * @param {string} text
 */
const amount = (text) => escape(text).replace(/ USDC$/, ' <small>USDC</small>');

/**
 * A score is the number and a meter under it. The meter is what lets two
 * listings be compared without reading either figure; an unpublished score
 * gets a dash and no bar at all, since there is nothing to measure yet.
 * @param {number|null} score
 */
const scoreCell = (score) => {
  const band = scoreBand(score);
  const meter = score === null ? '' : `<span class="meter"><span style="width:${(score / 10).toFixed(1)}%"></span></span>`;
  return `<span class="score ${band}"><b>${formatScore(score)}</b>${meter}</span>`;
};

/** @param {ServiceStatus} status */
const statusMark = (status) =>
  `<span class="state ${status.toLowerCase()}"><i class="dot"></i>${status.charAt(0)}${status.slice(1).toLowerCase()}</span>`;

/** @param {SlaOutcome} outcome */
const outcomeMark = (outcome) => `<span class="outcome ${outcome.toLowerCase()}"><i class="dot"></i>${outcome}</span>`;

/**
 * @param {Listing} listing
 * @param {boolean} selected
 */
function listingRow(listing, selected) {
  const published = listing.published;
  const unranked = published.conformance === null && published.availability === null;
  return `
    <button class="row${selected ? ' selected' : ''}" data-slug="${escape(listing.slug)}" type="button">
      <span class="cell name">
        <strong>${escape(listing.slug)}</strong>
        <small>${escape(listing.name)}</small>
        ${listing.contested ? '<span class="contested">contested</span>' : ''}
        ${unranked ? '<span class="unranked">not yet ranked</span>' : ''}
      </span>
      <span class="cell num">${scoreCell(published.conformance)}</span>
      <span class="cell num">${scoreCell(published.availability)}</span>
      <span class="cell num">${amount(formatNativeUsdc(listing.deposit, 2))}</span>
      <span class="cell status">${statusMark(listing.status)}</span>
    </button>`;
}

const listingHead = `
  <div class="row head">
    <span class="cell name">Service</span>
    <span class="cell num" title="Share of responses that arrived and met the SLA">Conformance</span>
    <span class="cell num" title="Share of paid calls that returned anything usable">Availability</span>
    <span class="cell num">Bond</span>
    <span class="cell status">Status</span>
  </div>`;

/**
 * @param {SlaClause} clause
 */
function clauseRow(clause) {
  const bound =
    clause.type === 'latency'
      ? `within ${clause.maxMs} ms`
      : clause.type === 'priceRange'
        ? `${formatMinorUsdc(BigInt(clause.minMinorUnits))} to ${formatMinorUsdc(BigInt(clause.maxMinorUnits))}`
        : 'matches the published shape';
  return `
    <tr>
      <td><code>${escape(clause.id)}</code></td>
      <td>${escape(clause.type)}</td>
      <td>${escape(bound)}</td>
      <td class="desc">${escape(/** @type {{description?: string}} */ (clause).description ?? '')}</td>
    </tr>`;
}

/**
 * What a verdict names as the clause that broke.
 *
 * A PASS names nothing, and neither does a failure judged on status alone — but
 * those are different facts, so they read differently. `'unknown'` is a third:
 * the verdict named a clause the SLA no longer declares, which means the
 * provider edited it after the fact. That is worth showing plainly rather than
 * rendering as a dash.
 *
 * @param {ListingVerdict} verdict
 */
function failedClauseCell(verdict) {
  if (verdict.outcome === 'PASS') return '<span class="muted">—</span>';
  if (verdict.failedClauseId === null) {
    return '<span class="muted" title="Judged on status alone: no SLA was in force for this call, so no clause was evaluated.">status only</span>';
  }
  if (verdict.failedClauseId === 'delivery') {
    return '<code title="The implicit clause every service is held to: a response arrived and was not a 5xx. No provider declares it.">delivery</code>';
  }
  if (verdict.failedClauseId === 'unknown') {
    return '<span class="warn" title="This verdict names a clause the published SLA no longer declares — it has been edited since.">edited since</span>';
  }
  return `<code>${escape(verdict.failedClauseId)}</code>`;
}

/** @param {ListingVerdict} verdict */
function verdictRow(verdict) {
  return `
    <tr class="verdict ${verdict.outcome.toLowerCase()}">
      <td>${outcomeMark(verdict.outcome)}</td>
      <td>${failedClauseCell(verdict)}</td>
      <td><code title="${escape(verdict.requestId)}">${escape(shortHex(verdict.requestId))}</code></td>
      <td><code title="${escape(verdict.payer)}">${escape(shortHex(verdict.payer))}</code></td>
      <td class="num">${escape(formatMinorUsdc(verdict.paidAmount))}</td>
      <td class="num">${verdict.refunded > 0n ? escape(formatNativeUsdc(verdict.refunded, 2)) : '<span class="muted">—</span>'}</td>
      <td class="num muted">${verdict.blockNumber === null ? '—' : escape(String(verdict.blockNumber))}</td>
    </tr>`;
}

/**
 * One mark per verdict, oldest on the left, so the shape of a service's record
 * — a clean run, one blip, a total collapse — is read before any row is.
 * @param {ListingVerdict[]} history newest first, as the listing carries it
 */
const verdictStrip = (history) =>
  `<div class="strip" aria-hidden="true">${history
    .map(
      (verdict) =>
        `<i class="${verdict.outcome.toLowerCase()}" title="${verdict.outcome}${
          verdict.blockNumber === null ? '' : ` · block ${verdict.blockNumber}`
        }"></i>`
    )
    .reverse()
    .join('')}</div>`;

/** @param {Listing} listing */
export function renderDetail(listing) {
  if (!listing) return '<p class="empty">Pick a service to see what it promised and what it delivered.</p>';

  const clauses = listing.sla?.clauses ?? [];
  const unpublished = listing.published.conformance === null;

  return `
    <header class="detail-head">
      <div>
        <h2>${escape(listing.slug)}</h2>
        <p class="sub"><code>${escape(listing.name)}</code> ${statusMark(listing.status)}</p>
      </div>
      <dl class="scores">
        <div><dt>Conformance</dt><dd>${scoreCell(listing.published.conformance)}</dd></div>
        <div><dt>Availability</dt><dd>${scoreCell(listing.published.availability)}</dd></div>
        <div><dt>Bond</dt><dd>${amount(formatNativeUsdc(listing.deposit, 2))}</dd></div>
      </dl>
    </header>

    ${
      unpublished
        ? `<p class="aside">
             No scores published yet — the hourly run has not written this
             subname. Over the verdicts below the same computation gives
             ${escape(formatScore(listing.unpublished.conformance))} conformance and
             ${escape(formatScore(listing.unpublished.availability))} availability, but the
             marketplace ranks on what is published, not on this.
           </p>`
        : ''
    }
    ${
      listing.namingLayer === 'unreachable'
        ? '<p class="aside warn">The naming layer did not answer, so this service’s SLA and scores could not be read. Its bond and verdict history are on Arc and are shown.</p>'
        : ''
    }
    ${
      listing.contested
        ? `<p class="aside warn">
             This slug's ENS subname and its Arc registration are owned by different
             addresses. The proxy refuses to route it until they agree — see
             <a href="?view=how">how it works</a>.
           </p>`
        : ''
    }

    <section class="block">
      <h3>Endpoint</h3>
      <table class="kv">
        <tr><th>Call</th><td><code>${escape(listing.slug)}.verdikt.bond/…</code></td></tr>
        <tr><th>Relays to</th><td><code>${escape(listing.endpoint ?? 'no url record published')}</code></td></tr>
        <tr><th>Pays to</th><td><code>${escape(listing.payTo ?? 'no address record published')}</code></td></tr>
        <tr><th>Provider</th><td><code>${escape(listing.provider)}</code></td></tr>
      </table>
    </section>

    <section class="block">
      <h3>What it promised <small>${clauses.length === 0 ? '' : `${clauses.length} clause${clauses.length === 1 ? '' : 's'}`}</small></h3>
      ${
        clauses.length === 0
          ? `<p class="aside">${
              listing.slaRaw
                ? 'The published SLA does not parse, so every call falls back to status-only judging: 2xx passes, 5xx fails, anything else writes no verdict.'
                : 'No SLA published. Every call falls back to status-only judging.'
            }</p>`
          : `<div class="scroll"><table class="clauses">
               <thead><tr><th>Clause</th><th>Type</th><th>Bound</th><th>Note</th></tr></thead>
               <tbody>${clauses.map(clauseRow).join('')}</tbody>
             </table></div>`
      }
    </section>

    <section class="block">
      <h3>What it delivered <small>${listing.history.length} verdict${listing.history.length === 1 ? '' : 's'}</small></h3>
      ${
        listing.history.length === 0
          ? '<p class="aside">No paid calls yet. A service nobody has called is presumed healthy — that is why it scores 1000 rather than 0.</p>'
          : `${verdictStrip(listing.history)}
             <div class="scroll"><table class="ledger">
               <thead><tr><th>Outcome</th><th>Broke</th><th>Request</th><th>Payer</th><th class="num">Paid</th><th class="num">Refunded</th><th class="num">Block</th></tr></thead>
               <tbody>${listing.history.map(verdictRow).join('')}</tbody>
             </table></div>
             <p class="aside">
               A FAIL or DOWN credits the payer from this service’s bond, capped at
               what they actually paid. The credit is booked, not sent — the agent
               calls <code>withdraw()</code> to collect.
             </p>`
      }
    </section>`;
}

/**
 * The provider's own view (Specification.md §5, stretch 1).
 *
 * A filter rather than a separate app: the same data, narrowed to one address.
 * The SLA editor validates against the engine's own `schema.json` — the one the
 * verifier enforces, so a provider cannot be told a document is fine and then
 * judged against a different rule — and sends the resulting transaction from
 * the signed-in provider's own connected wallet. Verdikt holds no key on the
 * provider's behalf; the SLA lives on ENS precisely so publishing needs no
 * Verdikt backend.
 *
 * @param {Listing[]} owned
 * @param {string} provider
 * @param {string} draft
 */
function renderProvider(owned, provider, draft) {
  const bonded = owned.reduce((total, listing) => total + listing.deposit, 0n);
  const refunded = owned.reduce(
    (total, listing) => total + listing.history.reduce((sum, verdict) => sum + verdict.refunded, 0n),
    0n
  );
  const verdicts = owned.reduce((n, listing) => n + listing.history.length, 0);
  const target = owned[0];

  return `
    <header class="masthead">
      <div>
        <h1><a href="?">Verdikt</a></h1>
        <p class="tagline">Provider <code>${escape(provider)}</code> · <a href="?">back to the marketplace</a></p>
      </div>
      <p class="source">${owned.length} service${owned.length === 1 ? '' : 's'}</p>
    </header>

    <section class="block">
      <h3>Add a service</h3>
      <div id="wizard-mount"></div>
    </section>

    <section class="figures">
      <div class="figure"><span class="value">${owned.length}</span><span class="label">services</span></div>
      <div class="figure"><span class="value">${amount(formatNativeUsdc(bonded, 2))}</span><span class="label">bonded</span></div>
      <div class="figure"><span class="value${refunded > 0n ? ' fail' : ''}">${amount(formatNativeUsdc(refunded, 2))}</span><span class="label">refunded from your bonds</span></div>
      <div class="figure"><span class="value">${verdicts}</span><span class="label">verdicts</span></div>
    </section>

    ${
      owned.length === 0
        ? '<p class="empty">No services registered by this address.</p>'
        : `<div class="layout">
             <section class="listing">
               ${listingHead}
               ${owned.map((listing) => listingRow(listing, false)).join('')}
             </section>
             <section class="detail">${renderDetail(/** @type {Listing} */ (target))}</section>
           </div>`
    }

    <section class="editor block">
      <h3>SLA editor <small>${target ? escape(target.name) : ''}</small></h3>
      <p class="aside">
        Validated against the same <code>schema.json</code> the verifier enforces, so
        this cannot tell you a document is fine and then have a call judged by a
        different rule. Sent from your own wallet — Verdikt holds no key of yours,
        which is why the SLA lives on ENS and not on Arc.
      </p>
      <div id="sla-editor-mount"></div>
    </section>

    <section class="block">
      <h3>Bond <small>${target ? escape(target.name) : ''}</small></h3>
      <div id="bond-controls-mount"></div>
    </section>`;
}

/**
 * The verdict breakdown as one thin bar with a labelled tally beneath. The
 * segments are the outcome colours; the words carry the identity, so the bar
 * never has to.
 * @param {PlatformStats} stats
 */
function verdictFigure(stats) {
  const { PASS, FAIL, DOWN } = stats.breakdown;
  const segment = (/** @type {string} */ name, /** @type {number} */ count) =>
    count === 0 ? '' : `<span class="seg ${name}" style="flex-grow:${count}"></span>`;
  return `
    <div class="figure">
      <span class="value">${stats.verdicts}</span>
      <span class="label">verdicts</span>
      ${
        stats.verdicts === 0
          ? ''
          : `<div class="breakdown">${segment('pass', PASS)}${segment('fail', FAIL)}${segment('down', DOWN)}</div>
             <span class="sub">
               <span class="pass"><i class="dot"></i>${PASS} pass</span>
               <span class="fail"><i class="dot"></i>${FAIL} fail</span>
               <span class="down"><i class="dot"></i>${DOWN} down</span>
             </span>`
      }
    </div>`;
}

/**
 * @param {Marketplace} marketplace
 * @param {'live'|'demo'} mode
 * @param {'marketplace'|'provider'|'how'} view
 * @param {string|null} selectedSlug
 * @param {string|null} [provider]
 * @param {string} [slaDraft]
 */
export function renderApp(marketplace, mode, view, selectedSlug, provider = null, slaDraft = '') {
  const { stats, services } = marketplace;
  const account = getConnectedAccount()?.address ?? null;
  if (view === 'how') {
    return `${renderNav({ view, mode, account })}${renderHowItWorks()}`;
  }
  if (provider) {
    const owned = services.filter((listing) => listing.provider.toLowerCase() === provider.toLowerCase());
    return `${renderNav({ view, mode, account })}${renderProvider(owned, provider, slaDraft)}`;
  }
  const selected = services.find((listing) => listing.slug === selectedSlug) ?? services[0] ?? null;

  return `${renderNav({ view, mode, account })}
    <header class="masthead">
      <div>
        <h1>Verdikt</h1>
        <p class="tagline">
          x402 services whose delivery is verified per call. Every response is judged
          against the SLA its provider published; a broken promise refunds the caller from
          the provider’s bond.
        </p>
      </div>
      <p class="source ${mode}"><i class="dot"></i>${mode === 'demo' ? 'demo data' : 'Arc Testnet'}</p>
    </header>

    ${
      mode === 'demo'
        ? `<p class="aside warn">
             Showing seeded data, not a live chain. Once the registry is
             deployed and recorded in <code>deployments/arc-testnet.json</code>,
             set <code>VITE_ARC_RPC_URL</code> to read Arc directly.
           </p>`
        : ''
    }

    <section class="figures">
      <div class="figure">
        <span class="value">${stats.services}</span>
        <span class="label">services</span>
        <span class="sub"><span>${stats.active} active</span>${stats.suspended > 0 ? `<span>${stats.suspended} suspended</span>` : ''}</span>
      </div>
      <div class="figure">
        <span class="value">${amount(formatNativeUsdc(stats.bonded, 2))}</span>
        <span class="label">bonded</span>
      </div>
      ${verdictFigure(stats)}
      <div class="figure">
        <span class="value">${amount(formatNativeUsdc(stats.refunded, 2))}</span>
        <span class="label">refunded</span>
        <span class="sub"><span>${stats.refundCount} refund${stats.refundCount === 1 ? '' : 's'}</span></span>
      </div>
    </section>

    <div class="layout">
      <section class="listing">
        ${listingHead}
        ${
          services.length === 0
            ? '<p class="empty">No services registered yet.</p>'
            : services.map((listing) => listingRow(listing, listing.slug === selected?.slug)).join('')
        }
      </section>

      <section class="detail">${renderDetail(/** @type {Listing} */ (selected))}</section>
    </div>

    <footer>
      Scores are the trailing ${Math.round(stats.windowSeconds / 86400)}-day ratios published on
      <code>&lt;slug&gt;.verdikt.eth</code>, recomputed hourly. Per-call verdicts are Arc events.
      A verdict is final: there is no dispute layer, by design.
      As of ${formatWhen(Math.floor(Date.now() / 1000))} UTC${
        services.length > 0
          ? ` · <a href="?provider=${escape(services[0].provider)}">provider view</a>`
          : ''
      }
    </footer>`;
}
