import { LitElement, html, nothing } from 'lit';
import { formatMinorUsdc, formatNativeUsdc, formatScore, formatWhen, scoreBand, shortHex } from './format.js';
import { getConnectedAccount } from './wallet.js';
import { getSession } from './session.js';
import { ARC, SEPOLIA } from '@verdikt/sdk';
import { resolveProviderConsole } from './provider.js';
import { HOW_PATH, LANDING_PATH, MARKETPLACE_PATH, PROVIDER_PATH, navigateOnClick, providerUrl, serviceUrl } from './router.js';
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

/** @param {SlaClause} clause */
const clauseBound = (clause) =>
  clause.type === 'latency'
    ? `within ${clause.maxMs} ms`
    : clause.type === 'priceRange'
      ? `${formatMinorUsdc(BigInt(clause.minMinorUnits))} to ${formatMinorUsdc(BigInt(clause.maxMinorUnits))}`
      : 'matches the published shape';

/** @param {ListingVerdict} verdict */
const failedClauseCell = (verdict) => {
  if (verdict.outcome === 'PASS') return html`<span class="muted">—</span>`;
  if (verdict.failedClauseId === null) return html`<span class="muted" title="Judged on status alone: no SLA was in force for this call, so no clause was evaluated.">status only</span>`;
  if (verdict.failedClauseId === 'delivery') return html`<code title="The implicit clause every service is held to: a response arrived and was not a 5xx. No provider declares it.">delivery</code>`;
  if (verdict.failedClauseId === 'unknown') return html`<span class="warn" title="This verdict names a clause the published SLA no longer declares — it has been edited since.">edited since</span>`;
  return html`<code>${verdict.failedClauseId}</code>`;
};

/** @param {Listing} listing @param {(path: string) => void} go */
const listingRow = (listing, go) => {
  const unranked = listing.published.conformance === null && listing.published.availability === null;
  const href = serviceUrl(listing.slug);
  return html`
    <a class="row" href=${href} data-slug=${listing.slug} @click=${navigateOnClick(go, href)}>
      <span class="cell name">
        <strong>${listing.slug}</strong><small>${listing.name}</small>
        ${listing.contested ? html`<span class="contested">contested</span>` : nothing}
        ${unranked ? html`<span class="unranked">not yet ranked</span>` : nothing}
      </span>
      <span class="cell num">${scoreCell(listing.published.conformance)}</span>
      <span class="cell num">${scoreCell(listing.published.availability)}</span>
      <span class="cell num">${amount(formatNativeUsdc(listing.deposit, 2))}</span>
      <span class="cell status">${statusMark(listing.status)}</span>
    </a>`;
};

/** @param {Listing|null} listing */
export const detailTemplate = (listing) => {
  if (!listing) return html`<p class="empty">Pick a service to see what it promised and what it delivered.</p>`;
  const clauses = listing.sla?.clauses ?? [];
  const unpublished = listing.published.conformance === null;
  return html`
    <header class="detail-head">
      <div><h2>${listing.slug}</h2><p class="sub"><code>${listing.name}</code> ${statusMark(listing.status)}</p></div>
      <dl class="scores">
        <div><dt>Conformance</dt><dd>${scoreCell(listing.published.conformance)}</dd></div>
        <div><dt>Availability</dt><dd>${scoreCell(listing.published.availability)}</dd></div>
        <div><dt>Bond</dt><dd>${amount(formatNativeUsdc(listing.deposit, 2))}</dd></div>
      </dl>
    </header>
    ${unpublished ? html`<p class="aside">No scores published yet — the hourly run has not written this subname. Over the verdicts below the same computation gives ${formatScore(listing.unpublished.conformance)} conformance and ${formatScore(listing.unpublished.availability)} availability, but the marketplace ranks on what is published, not on this.</p>` : nothing}
    ${listing.namingLayer === 'unreachable' ? html`<p class="aside warn">The naming layer did not answer, so this service’s SLA and scores could not be read. Its bond and verdict history are on Arc and are shown.</p>` : nothing}
    ${listing.contested ? html`<p class="aside warn">This slug's ENS subname and its Arc registration are owned by different addresses. The proxy refuses to route it until they agree — see <a href="/how">how it works</a>.</p>` : nothing}
    <section class="block">
      <h3>Endpoint</h3>
      <table class="kv">
        <tr><th>Call</th><td><code>${listing.slug}.verdikt.bond/…</code></td></tr>
        <tr><th>Relays to</th><td><code>${listing.endpoint ?? 'no url record published'}</code></td></tr>
        <tr><th>Pays to</th><td><code>${listing.payTo ?? 'no address record published'}</code></td></tr>
        <tr><th>Provider</th><td><code>${listing.provider}</code></td></tr>
      </table>
    </section>
    <section class="block">
      <h3>What it promised <small>${clauses.length ? `${clauses.length} clause${clauses.length === 1 ? '' : 's'}` : ''}</small></h3>
      ${clauses.length === 0
        ? html`<p class="aside">${listing.slaRaw ? 'The published SLA does not parse, so every call falls back to status-only judging: 2xx passes, 5xx fails, anything else writes no verdict.' : 'No SLA published. Every call falls back to status-only judging.'}</p>`
        : html`<div class="scroll"><table class="clauses"><thead><tr><th>Clause</th><th>Type</th><th>Bound</th><th>Note</th></tr></thead><tbody>${clauses.map((clause) => html`<tr><td><code>${clause.id}</code></td><td>${clause.type}</td><td>${clauseBound(clause)}</td><td class="desc">${/** @type {{description?: string}} */ (clause).description ?? ''}</td></tr>`)}</tbody></table></div>`}
    </section>
    <section class="block">
      <h3>What it delivered <small>${listing.history.length} verdict${listing.history.length === 1 ? '' : 's'}</small></h3>
      ${listing.history.length === 0
        ? html`<p class="aside">No paid calls yet. A service nobody has called is presumed healthy — that is why it scores 1000 rather than 0.</p>`
        : html`
          <div class="strip" aria-hidden="true">${[...listing.history].reverse().map((verdict) => html`<i class=${verdict.outcome.toLowerCase()} title=${`${verdict.outcome}${verdict.blockNumber === null ? '' : ` · block ${verdict.blockNumber}`}`}></i>`)}</div>
          <div class="scroll"><table class="ledger"><thead><tr><th>Outcome</th><th>Broke</th><th>Request</th><th>Payer</th><th class="num">Paid</th><th class="num">Refunded</th><th class="num">Block</th></tr></thead><tbody>
            ${listing.history.map((verdict) => html`<tr class="verdict ${verdict.outcome.toLowerCase()}"><td>${outcomeMark(verdict.outcome)}</td><td>${failedClauseCell(verdict)}</td><td><code title=${verdict.requestId}>${shortHex(verdict.requestId)}</code></td><td><code title=${verdict.payer}>${shortHex(verdict.payer)}</code></td><td class="num">${formatMinorUsdc(verdict.paidAmount)}</td><td class="num">${verdict.refunded > 0n ? formatNativeUsdc(verdict.refunded, 2) : html`<span class="muted">—</span>`}</td><td class="num muted">${verdict.blockNumber ?? '—'}</td></tr>`)}
          </tbody></table></div>
          <p class="aside">A FAIL or DOWN credits the payer from this service’s bond, capped at what they actually paid. The credit is booked, not sent — the agent calls <code>withdraw()</code> to collect.</p>`}
    </section>`;
};

/** @param {'landing'|'marketplace'|'service'|'provider'|'how'|'terms'|'privacy'} view @param {'live'|'demo'} mode @param {'light'|'dark'} theme @param {string|null} account @param {(path: string) => void} go @param {() => void} connect @param {() => void} disconnect @param {(theme: 'light'|'dark') => void} changeTheme */
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
  ${pageHead('How it works', 'How the verification loop works, end to end.')}
  <section class="block"><h3>Two chains, each for one reason</h3><p><strong>Arc</strong> holds the registry, the escrow, the verdicts and the refunds — and the x402 payment itself. USDC is Arc's native gas token, so value moves as <code>msg.value</code>, not an ERC-20 transfer: no <code>approve</code>/<code>transferFrom</code>, no token address. Payment, bond and refund are the same asset on the same chain, which removes any cross-chain correlation between payment and refund.</p><p><strong>Ethereum Sepolia</strong> holds ENS. The SLA lives only as the <code>sla</code> text record on <code>&lt;slug&gt;.verdikt.eth</code>. A per-key access list scopes the provider to <code>sla</code> and <code>url</code>, and the CRE signer to <code>conformance</code> and <code>availability</code>.</p></section>
  <section class="block"><h3>What happens on a paid call</h3><p>A proxy sits between the paying agent and the provider's x402 endpoint. Without a payment header, it checks that the challenge's payout address matches ENS. With payment attached, the call is replayed inside a Chainlink CRE Confidential Workflow and evaluated against the provider's published SLA without exposing the raw response outside the enclave.</p><p>The workflow writes PASS, FAIL or DOWN on Arc. A FAIL or DOWN credits the payer from the service's bond, capped at <code>min(fixed refund, what was actually paid, what remains of the bond)</code>.</p></section>
  <section class="block"><h3>Why there is no dispute layer</h3><p>A verdict is final by design. The refund cap keeps a false FAIL from being worth manufacturing, and the observed value never goes on-chain. The clause, refund and trailing seven-day scores remain public on Arc and ENS.</p></section>`;

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
    /** @type {{view: 'landing'|'marketplace'|'service'|'provider'|'how'|'terms'|'privacy', slug: string|null, address: string|null, rejected?: string|null}} */
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
  /** @param {Listing[]} owned @param {string} provider @param {(path: string) => void} go */
  renderProvider(owned, provider, go) {
    const account = getConnectedAccount();
    const ownPage = account?.address.toLowerCase() === provider.toLowerCase();
    const supported = account && [ARC.chainId, SEPOLIA.chainId].includes(account.chainId);
    // `ownPage &&` first keeps getSession() — and localStorage — out of the
    // server-side render used by the tests.
    const signedIn = ownPage && getSession()?.address.toLowerCase() === account?.address.toLowerCase();
    // Mirrors mountProviderConsole's `sessionMatchesAccount && viewingOwnPage`
    // in main.js: a section rendered without a matching mount is a dead
    // control, a mount without a section is invisible. Pinned by a test.
    const canWrite = Boolean(signedIn && supported);
    const bonded = owned.reduce((total, listing) => total + listing.deposit, 0n);
    const refunded = owned.reduce((total, listing) => total + listing.history.reduce((sum, verdict) => sum + verdict.refunded, 0n), 0n);
    const verdicts = owned.reduce((total, listing) => total + listing.history.length, 0);
    const target = owned[0] ?? null;
    return html`<header class="page-head"><div><p class="tagline">Provider <code>${provider}</code> · <a href=${MARKETPLACE_PATH} @click=${navigateOnClick(go, MARKETPLACE_PATH)}>back to the marketplace</a></p></div><p class="source">${owned.length} service${owned.length === 1 ? '' : 's'}</p></header>
      ${ownPage && (!signedIn || !supported) ? html`<div class="aside"><p>${signedIn ? 'Switch to a supported network to manage your services.' : 'Sign in once to manage your services. Your sign-in lasts 24 hours in this browser.'}</p><wa-button size="s" appearance="outlined" ?disabled=${this.signInPending} ?loading=${this.signInPending} @click=${this.signIn}>${signedIn ? 'Switch network' : 'Enable provider actions'}</wa-button>${this.signInError ? html`<p role="status">${this.signInError}</p>` : nothing}</div>` : nothing}
      ${canWrite ? html`<section class="block"><h3>Add a service</h3><verdikt-wizard id="wizard-mount"></verdikt-wizard></section>` : nothing}
      <section class="figures"><div class="figure"><span class="value">${owned.length}</span><span class="label">services</span></div><div class="figure"><span class="value">${amount(formatNativeUsdc(bonded, 2))}</span><span class="label">bonded</span></div><div class="figure"><span class="value ${refunded > 0n ? 'fail' : ''}">${amount(formatNativeUsdc(refunded, 2))}</span><span class="label">${ownPage ? 'refunded from your bonds' : 'refunded from these bonds'}</span></div><div class="figure"><span class="value">${verdicts}</span><span class="label">verdicts</span></div></section>
      ${owned.length === 0 ? html`<p class="empty">No services registered by this address.</p>` : html`<div class="layout"><section class="listing">${listingHead()}${owned.map((listing) => listingRow(listing, go))}</section><section class="detail">${detailTemplate(target)}</section></div>`}
      ${target && canWrite ? html`
        <section class="editor block"><h3>SLA editor <small>${target.name}</small></h3><p class="aside">Validated against the same <code>schema.json</code> the verifier enforces. Sent from your own wallet; Verdikt holds no key of yours.</p><verdikt-sla-editor id="sla-editor-mount"></verdikt-sla-editor></section>
        <section class="block"><h3>Bond <small>${target.name}</small></h3><verdikt-bond-controls id="bond-controls-mount"></verdikt-bond-controls></section>` : nothing}`;
  }
  /** @param {PlatformStats} stats @param {Listing[]} services @param {(path: string) => void} go */
  renderMarketplace(stats, services, go) {
    return html`${pageHead('Marketplace', TAGLINE, html`<p class="source ${this.mode}"><i class="dot"></i>${this.mode === 'demo' ? 'demo data' : 'Arc Testnet'}</p>`)}
      ${this.mode === 'demo' ? html`<p class="aside warn">Showing seeded data, not a live chain. Set <code>VITE_ARC_RPC_URL</code> to read Arc directly.</p>` : nothing}
      <section class="listing flush">${listingHead()}${services.length ? services.map((listing) => listingRow(listing, go)) : html`<p class="empty">No services registered yet.</p>`}</section>
      <footer>Scores are the trailing ${Math.round(stats.windowSeconds / 86400)}-day ratios published on <code>&lt;slug&gt;.verdikt.eth</code>, recomputed hourly. Per-call verdicts are Arc events. A verdict is final: there is no dispute layer, by design. As of ${formatWhen(Math.floor(Date.now() / 1000))} UTC${services.length ? html` · <a href=${providerUrl(services[0].provider)} @click=${navigateOnClick(go, providerUrl(services[0].provider))}>provider view</a>` : nothing}</footer>`;
  }
  /** @param {Listing[]} services @param {string} slug @param {(path: string) => void} go */
  renderService(services, slug, go) {
    const listing = services.find((service) => service.slug === slug) ?? null;
    const back = html`<p class="back"><a href=${MARKETPLACE_PATH} @click=${navigateOnClick(go, MARKETPLACE_PATH)}>← back to the marketplace</a></p>`;
    if (!listing) return html`${back}<p class="empty">No service found for “${slug}”.</p>`;
    return html`${back}${this.mode === 'demo' ? html`<p class="aside warn">Showing seeded data, not a live chain. Set <code>VITE_ARC_RPC_URL</code> to read Arc directly.</p>` : nothing}${detailTemplate(listing)}`;
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
    if (this.error) return html`${navBar}<p class="note warn">Could not load the marketplace: ${this.error}</p>${legalFooter(go)}`;
    if (!this.marketplace) return html`${navBar}${skeleton()}${legalFooter(go)}`;
    const { services, stats } = this.marketplace;
    const body = this.route.view === 'how'
      ? how()
      : this.route.view === 'service'
        ? this.renderService(services, /** @type {string} */ (this.route.slug), go)
        : this.route.view === 'provider'
          ? this.renderProvider(resolveProviderConsole(services, this.route.address).owned, /** @type {string} */ (this.route.address), go)
          : this.renderMarketplace(stats, services, go);
    return html`${navBar}${body}${legalFooter(go)}`;
  }
}

if (!customElements.get('verdikt-app')) customElements.define('verdikt-app', VerdiktApp);
