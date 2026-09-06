// DOM rendering. No framework: the whole surface is a list, a detail panel and
// a stats strip, and a framework would be the largest dependency in the repo
// for markup that fits in one file.

import { formatMinorUsdc, formatNativeUsdc, formatScore, formatWhen, scoreBand, shortHex } from './format.js';

/** @param {unknown} value */
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character
  );

/** @param {number|null} score */
const scoreCell = (score) => `<span class="score ${scoreBand(score)}">${formatScore(score)}</span>`;

/** @param {ServiceStatus} status */
const statusBadge = (status) => `<span class="badge ${status.toLowerCase()}">${status}</span>`;

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
        <small>${escape(listing.name)}${unranked ? ' · not yet ranked' : ''}</small>
      </span>
      <span class="cell num">${scoreCell(published.conformance)}</span>
      <span class="cell num">${scoreCell(published.availability)}</span>
      <span class="cell num">${escape(formatNativeUsdc(listing.deposit, 2))}</span>
      <span class="cell status">${statusBadge(listing.status)}</span>
    </button>`;
}

/**
 * @param {SlaClause} clause
 */
function clauseRow(clause) {
  const bound =
    clause.type === 'latency'
      ? `≤ ${clause.maxMs}ms`
      : clause.type === 'priceRange'
        ? `${formatMinorUsdc(BigInt(clause.minMinorUnits))} – ${formatMinorUsdc(BigInt(clause.maxMinorUnits))}`
        : 'response must match the published shape';
  return `
    <tr>
      <td><code>${escape(clause.id)}</code></td>
      <td>${escape(clause.type)}</td>
      <td>${escape(bound)}</td>
      <td class="muted">${escape(/** @type {{description?: string}} */ (clause).description ?? '')}</td>
    </tr>`;
}

/** @param {ListingVerdict} verdict */
function verdictRow(verdict) {
  return `
    <tr class="verdict ${verdict.outcome.toLowerCase()}">
      <td><span class="outcome ${verdict.outcome.toLowerCase()}">${verdict.outcome}</span></td>
      <td><code title="${escape(verdict.requestId)}">${escape(shortHex(verdict.requestId))}</code></td>
      <td><code>${escape(shortHex(verdict.payer))}</code></td>
      <td class="num">${escape(formatMinorUsdc(verdict.paidAmount))}</td>
      <td class="num">${verdict.refunded > 0n ? escape(formatNativeUsdc(verdict.refunded, 2)) : '—'}</td>
      <td class="num muted">${verdict.blockNumber === null ? '—' : escape(String(verdict.blockNumber))}</td>
    </tr>`;
}

/** @param {Listing} listing */
export function renderDetail(listing) {
  if (!listing) return '<p class="empty">Pick a service to see what it promised and what it delivered.</p>';

  const clauses = listing.sla?.clauses ?? [];
  const unpublished = listing.published.conformance === null;

  return `
    <header class="detail-head">
      <div>
        <h2>${escape(listing.slug)}</h2>
        <p class="muted">${escape(listing.name)} ${statusBadge(listing.status)}</p>
      </div>
      <dl class="scores">
        <div><dt>Conformance</dt><dd>${scoreCell(listing.published.conformance)}</dd></div>
        <div><dt>Availability</dt><dd>${scoreCell(listing.published.availability)}</dd></div>
        <div><dt>Bond</dt><dd>${escape(formatNativeUsdc(listing.deposit, 2))}</dd></div>
      </dl>
    </header>

    ${
      unpublished
        ? `<p class="note">
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
        ? '<p class="note warn">The naming layer did not answer, so this service’s SLA and scores could not be read. Its bond and verdict history are on Arc and are shown.</p>'
        : ''
    }

    <section>
      <h3>Endpoint</h3>
      <table class="kv">
        <tr><th>Call</th><td><code>${escape(listing.slug)}.verdikt.bond/…</code></td></tr>
        <tr><th>Relays to</th><td><code>${escape(listing.endpoint ?? 'no url record published')}</code></td></tr>
        <tr><th>Pays to</th><td><code>${escape(listing.payTo ?? 'no address record published')}</code></td></tr>
        <tr><th>Provider</th><td><code>${escape(listing.provider)}</code></td></tr>
      </table>
    </section>

    <section>
      <h3>What it promised</h3>
      ${
        clauses.length === 0
          ? `<p class="note">${
              listing.slaRaw
                ? 'The published SLA does not parse, so every call falls back to status-only judging: 2xx passes, 5xx fails, anything else writes no verdict.'
                : 'No SLA published. Every call falls back to status-only judging.'
            }</p>`
          : `<table>
               <thead><tr><th>Clause</th><th>Type</th><th>Bound</th><th>Note</th></tr></thead>
               <tbody>${clauses.map(clauseRow).join('')}</tbody>
             </table>`
      }
    </section>

    <section>
      <h3>What it delivered <small class="muted">${listing.history.length} verdicts</small></h3>
      ${
        listing.history.length === 0
          ? '<p class="note">No paid calls yet. A service nobody has called is presumed healthy — that is why it scores 1000 rather than 0.</p>'
          : `<table>
               <thead><tr><th>Outcome</th><th>Request</th><th>Payer</th><th>Paid</th><th>Refunded</th><th>Block</th></tr></thead>
               <tbody>${listing.history.map(verdictRow).join('')}</tbody>
             </table>
             <p class="muted small">
               A FAIL or DOWN credits the payer from this service’s bond, capped at
               what they actually paid. The credit is booked, not sent — the agent
               calls <code>withdraw()</code> to collect.
             </p>`
      }
    </section>`;
}

/**
 * @param {Marketplace} marketplace
 * @param {'live'|'demo'} mode
 * @param {string|null} selectedSlug
 */
export function renderApp(marketplace, mode, selectedSlug) {
  const { stats, services } = marketplace;
  const selected = services.find((listing) => listing.slug === selectedSlug) ?? services[0] ?? null;

  return `
    <header class="top">
      <div>
        <h1>Verdikt</h1>
        <p class="muted">x402 services whose delivery is verified per call, with refunds enforced on-chain.</p>
      </div>
      <span class="badge ${mode}">${mode === 'demo' ? 'demo data' : 'Arc Testnet'}</span>
    </header>

    ${
      mode === 'demo'
        ? `<p class="note warn">
             Showing seeded data, not a live chain. The registry is not deployed
             yet — set <code>VITE_ARC_RPC_URL</code> and
             <code>VITE_VERDIKT_REGISTRY_ADDRESS</code> to read Arc directly.
           </p>`
        : ''
    }

    <section class="stats">
      <div class="stat"><span class="value">${stats.services}</span><span class="label">services</span></div>
      <div class="stat"><span class="value">${stats.active}</span><span class="label">active</span></div>
      <div class="stat"><span class="value">${stats.suspended}</span><span class="label">suspended</span></div>
      <div class="stat"><span class="value">${escape(formatNativeUsdc(stats.bonded, 2))}</span><span class="label">bonded</span></div>
      <div class="stat"><span class="value">${stats.verdicts}</span><span class="label">verdicts</span></div>
      <div class="stat"><span class="value pass">${stats.breakdown.PASS}</span><span class="label">pass</span></div>
      <div class="stat"><span class="value fail">${stats.breakdown.FAIL}</span><span class="label">fail</span></div>
      <div class="stat"><span class="value down">${stats.breakdown.DOWN}</span><span class="label">down</span></div>
      <div class="stat"><span class="value">${escape(formatNativeUsdc(stats.refunded, 2))}</span><span class="label">refunded</span></div>
    </section>

    <div class="layout">
      <section class="listing">
        <div class="row head">
          <span class="cell name">Service</span>
          <span class="cell num" title="Share of responses that arrived and met the SLA">Conformance</span>
          <span class="cell num" title="Share of paid calls that returned anything usable">Availability</span>
          <span class="cell num">Bond</span>
          <span class="cell status">Status</span>
        </div>
        ${
          services.length === 0
            ? '<p class="empty">No services registered yet.</p>'
            : services.map((listing) => listingRow(listing, listing.slug === selected?.slug)).join('')
        }
      </section>

      <section class="detail">${renderDetail(/** @type {Listing} */ (selected))}</section>
    </div>

    <footer class="muted small">
      Scores are the trailing ${Math.round(stats.windowSeconds / 86400)}-day ratios published on
      <code>&lt;slug&gt;.verdikt.eth</code>, recomputed hourly. Per-call verdicts are Arc events.
      A verdict is final: there is no dispute layer, by design.
      ${formatWhen(Math.floor(Date.now() / 1000))}
    </footer>`;
}
