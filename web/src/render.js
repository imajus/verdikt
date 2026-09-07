// DOM rendering. No framework: the whole surface is a list, a detail panel and
// a stats strip, and a framework would be the largest dependency in the repo
// for markup that fits in one file.

import { setTextCalldata } from '@verdikt/sdk';
import { parseSla } from '@verdikt/sla';
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
      <td><span class="outcome ${verdict.outcome.toLowerCase()}">${verdict.outcome}</span></td>
      <td>${failedClauseCell(verdict)}</td>
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
               <thead><tr><th>Outcome</th><th>Broke</th><th>Request</th><th>Payer</th><th>Paid</th><th>Refunded</th><th>Block</th></tr></thead>
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
 * The provider's own view (Specification.md §5, stretch 1).
 *
 * A filter rather than a separate app: the same data, narrowed to one address.
 * The SLA editor validates against the engine's own `schema.json` — the one the
 * verifier enforces, so a provider cannot be told a document is fine and then
 * judged against a different rule — and produces the transaction to sign
 * WITHOUT sending it. Verdikt holds no key on the provider's behalf; the SLA
 * lives on ENS precisely so publishing needs no Verdikt backend.
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
  const target = owned[0];
  const source = draft || target?.slaRaw || '';

  /** @type {{ ok: boolean, message: string }} */
  let check = { ok: false, message: 'Paste an SLA to validate it.' };
  if (source.trim()) {
    try {
      const parsed = parseSla(source);
      check = { ok: true, message: `Valid. ${parsed.clauses.length} clause(s); the verifier would enforce all of them.` };
    } catch (error) {
      check = { ok: false, message: /** @type {Error} */ (error).message };
    }
  }

  let call = null;
  if (check.ok && target) {
    try {
      call = setTextCalldata(target.slug, 'sla', source);
    } catch {
      call = null;
    }
  }

  return `
    <header class="top">
      <div>
        <h1>Provider</h1>
        <p class="muted"><code>${escape(provider)}</code> · <a href="?">back to the marketplace</a></p>
      </div>
      <span class="badge live">${owned.length} service${owned.length === 1 ? '' : 's'}</span>
    </header>

    <section class="stats">
      <div class="stat"><span class="value">${owned.length}</span><span class="label">services</span></div>
      <div class="stat"><span class="value">${escape(formatNativeUsdc(bonded, 2))}</span><span class="label">bonded</span></div>
      <div class="stat"><span class="value fail">${escape(formatNativeUsdc(refunded, 2))}</span><span class="label">refunded from your bonds</span></div>
      <div class="stat"><span class="value">${owned.reduce((n, l) => n + l.history.length, 0)}</span><span class="label">verdicts</span></div>
    </section>

    ${
      owned.length === 0
        ? '<p class="empty">No services registered by this address.</p>'
        : `<div class="layout"><section class="listing">
             <div class="row head">
               <span class="cell name">Service</span>
               <span class="cell num">Conformance</span>
               <span class="cell num">Availability</span>
               <span class="cell num">Bond</span>
               <span class="cell status">Status</span>
             </div>
             ${owned.map((listing) => listingRow(listing, false)).join('')}
           </section>
           <section class="detail">${renderDetail(/** @type {Listing} */ (target))}</section></div>`
    }

    <section class="detail" style="margin-top:24px">
      <h3>SLA editor <small class="muted">${target ? escape(target.name) : ''}</small></h3>
      <p class="muted small">
        Validated against the same <code>schema.json</code> the verifier enforces, so
        this cannot tell you a document is fine and then have a call judged by a
        different rule. Nothing is sent: Verdikt holds no key of yours, which is
        why the SLA lives on ENS and not on Arc.
      </p>
      <textarea id="sla-draft" spellcheck="false" rows="14">${escape(source)}</textarea>
      <p class="note ${check.ok ? '' : 'warn'}">${escape(check.message)}</p>
      ${
        call
          ? `<h3>Transaction to sign</h3>
             <table class="kv">
               <tr><th>to</th><td><code>${escape(call.to)}</code></td></tr>
               <tr><th>function</th><td><code>setText(bytes32,string,string)</code></td></tr>
               <tr><th>data</th><td><code class="wrap">${escape(call.data)}</code></td></tr>
             </table>
             <p class="muted small">Send from the address that owns ${escape(call.name)}. It is scoped to <code>sla</code> and <code>url</code> only — writing <code>conformance</code> reverts.</p>`
          : ''
      }
    </section>`;
}

/**
 * @param {Marketplace} marketplace
 * @param {'live'|'demo'} mode
 * @param {string|null} selectedSlug
 * @param {string|null} [provider]
 * @param {string} [slaDraft]
 */
export function renderApp(marketplace, mode, selectedSlug, provider = null, slaDraft = '') {
  const { stats, services } = marketplace;
  if (provider) {
    const owned = services.filter((listing) => listing.provider.toLowerCase() === provider.toLowerCase());
    return renderProvider(owned, provider, slaDraft);
  }
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
             Showing seeded data, not a live chain. Once the registry is
             deployed and recorded in <code>deployments/arc-testnet.json</code>,
             set <code>VITE_ARC_RPC_URL</code> to read Arc directly.
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
      ${
        services.length > 0
          ? `· <a href="?provider=${escape(services[0].provider)}">provider view</a>`
          : ''
      }
    </footer>`;
}
