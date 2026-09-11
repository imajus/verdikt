// Static content the dashboard shows with no chain data behind it: the
// landing page, the legal pages, and the footer linking to them. Kept apart
// from lit-app.js's marketplace/provider/how templates because none of these
// need `Marketplace`/`Listing` data or a loaded route — see
// docs/superpowers/specs/2026-09-11-landing-routing-legal-design.md §3, §7.

import { html } from 'lit';

export const TAGLINE = 'x402 services whose delivery is verified per call. Every response is judged against the SLA its provider published; a broken promise refunds the caller from the provider\'s bond.';

/** @param {(path: string) => void} go @param {string} path */
const follow = (go, path) => (/** @type {Event} */ event) => { event.preventDefault(); go(path); };

/** @param {(path: string) => void} go */
export const landing = (go) => html`
  <header class="masthead">
    <div>
      <h1><a class="brand" href="/" aria-label="Verdikt home" @click=${follow(go, '/')}><img class="brand-mark" src="/favicon.svg" alt="" width="42" height="42" /><span>Verdikt</span></a></h1>
      <p class="tagline">${TAGLINE}</p>
    </div>
  </header>
  <p class="landing-cta">
    <wa-button href="/marketplace" @click=${follow(go, '/marketplace')}>Browse the marketplace</wa-button>
  </p>`;

export const terms = () => html`
  <h2 class="page-title">Terms of Service</h2>
  <p class="aside">Last updated 2026-09-11. This is a hackathon demo — the text below is a plain description of what the app does, not reviewed legal advice.</p>
  <section class="block">
    <h3>What Verdikt is</h3>
    <p>Verdikt is a demo marketplace of x402-gated API services. It has no backend and no accounts: this page reads Arc Testnet and Ethereum Sepolia directly from your browser, and every write — registering a service, publishing an SLA, connecting a wallet — is a transaction you sign yourself. Verdikt never holds a key of yours and never takes custody of funds.</p>
  </section>
  <section class="block">
    <h3>No warranty</h3>
    <p>Everything here — listings, scores, verdicts, refunds — is provided as-is, for demonstration purposes, with no warranty of any kind. A verdict written by the verification workflow is final by design (see <a href="/how">how it works</a>); Verdikt is not a party to, and takes no responsibility for, any agreement between a provider and a caller.</p>
  </section>
  <section class="block">
    <h3>Use at your own risk</h3>
    <p>Testnet assets have no value. If Verdikt is ever used against a live network, you are responsible for your own wallet, keys and transactions. Do not rely on this software for anything where a bug or an outage would cause real harm.</p>
  </section>`;

export const privacy = () => html`
  <h2 class="page-title">Privacy Policy</h2>
  <p class="aside">Last updated 2026-09-11. This is a hackathon demo — the text below is a plain description of what the app does, not reviewed legal advice.</p>
  <section class="block">
    <h3>What we collect</h3>
    <p>Nothing. There is no Verdikt server behind this page — it is a static site that reads Arc Testnet and Ethereum Sepolia over public RPC endpoints straight from your browser. No account, email or personal data is requested or stored by Verdikt.</p>
  </section>
  <section class="block">
    <h3>What's public by nature of the chain</h3>
    <p>Anything you do on-chain — registering a service, publishing an SLA, a payment, a verdict, a refund — is public, permanent blockchain data, visible to anyone, independent of this page. Connecting a wallet only reads the address it reports; that address is never sent anywhere by Verdikt.</p>
  </section>
  <section class="block">
    <h3>Local storage</h3>
    <p>Your theme preference and, if you sign in as a provider, a short-lived proof of address control (<a href="/how">how it works</a>) are kept in your browser's local storage. Neither ever leaves your device.</p>
  </section>`;

/** @param {(path: string) => void} go */
export const legalFooter = (go) => html`
  <footer class="legal">
    <a href="/terms" @click=${follow(go, '/terms')}>Terms</a>
    <a href="/privacy" @click=${follow(go, '/privacy')}>Privacy</a>
  </footer>`;
