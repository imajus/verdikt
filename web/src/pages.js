// Static content the dashboard shows with no chain data behind it: the legal
// pages, the shared page head, and the footer linking to them. Kept apart from
// lit-app.js's marketplace/provider/how templates because none of these need
// `Marketplace`/`Listing` data or a loaded route — see
// docs/superpowers/specs/2026-09-11-landing-routing-legal-design.md §3, §7.
//
// The landing page used to live here too. It reads chain data now, so it moved
// to landing.js; TAGLINE stays because every page's head uses it.

import { html, nothing } from 'lit';
import { HOW_PATH, PRIVACY_PATH, TERMS_PATH, navigateOnClick } from './router.js';

export const TAGLINE = 'x402 services whose delivery is verified per call. Every response is judged against the SLA its provider published; a broken promise refunds the caller from the provider’s bond.';

// The generic title+description bar shown at the top of every page except
// the landing page — see docs/superpowers/specs/2026-09-11-navbar-page-head-design.md.
// The brand/logo lives in the nav instead (nav() in lit-app.js), so this
// carries no logo of its own.
/** @param {string} title @param {unknown} description @param {unknown} [aside] */
export const pageHead = (title, description, aside = nothing) => html`
  <header class="page-head">
    <div><h1>${title}</h1><p class="tagline">${description}</p></div>
    ${aside}
  </header>`;

export const terms = () => html`
  ${pageHead('Terms of Service', 'Last updated 2026-09-11. This is a hackathon demo — the text below is a plain description of what the app does, not reviewed legal advice.')}
  <section class="block">
    <h3>What Verdikt is</h3>
    <p>Verdikt is a demo marketplace of x402-gated API services. It has no backend and no accounts: this page reads Arc Testnet and Ethereum Sepolia directly from your browser, and every write — registering a service, publishing an SLA, connecting a wallet — is a transaction you sign yourself. Verdikt never holds a key of yours and never takes custody of funds.</p>
  </section>
  <section class="block">
    <h3>No warranty</h3>
    <p>Everything here — listings, scores, verdicts, refunds — is provided as-is, for demonstration purposes, with no warranty of any kind. A verdict written by the verification workflow is final by design (see <a href=${HOW_PATH}>how it works</a>); Verdikt is not a party to, and takes no responsibility for, any agreement between a provider and a caller.</p>
  </section>
  <section class="block">
    <h3>Use at your own risk</h3>
    <p>Testnet assets have no value. If Verdikt is ever used against a live network, you are responsible for your own wallet, keys and transactions. Do not rely on this software for anything where a bug or an outage would cause real harm.</p>
  </section>`;

export const privacy = () => html`
  ${pageHead('Privacy Policy', 'Last updated 2026-09-11. This is a hackathon demo — the text below is a plain description of what the app does, not reviewed legal advice.')}
  <section class="block">
    <h3>What we collect</h3>
    <p>Nothing, unless you fill in one of the two forms on the landing page. There is no Verdikt server behind this page — it is a static site that reads Arc Testnet and Ethereum Sepolia over public RPC endpoints straight from your browser. No account is ever created, and browsing, connecting a wallet or reading a service costs you no personal data at all.</p>
  </section>
  <section class="block">
    <h3>The two forms on the landing page</h3>
    <p>Because there is no Verdikt server, a submitted form does not reach one. The subscribe and contact forms post what you typed — an email address, and for the contact form your message — directly from your browser to a third-party form service, whose submit URL is compiled into this page and visible in its source. That service, not Verdikt, stores what you send and is where a deletion request has to go; we read it to answer you and to send the milestone notes you asked for, and we do not pass it on.</p>
    <p>If the forms show that no endpoint is configured in this build, nothing can be submitted at all — there is no fallback that quietly stores your address somewhere else.</p>
  </section>
  <section class="block">
    <h3>What's public by nature of the chain</h3>
    <p>Anything you do on-chain — registering a service, publishing an SLA, a payment, a verdict, a refund — is public, permanent blockchain data, visible to anyone, independent of this page. Connecting a wallet only reads the address it reports; that address is never sent anywhere by Verdikt.</p>
  </section>
  <section class="block">
    <h3>Local storage</h3>
    <p>Your theme preference and, if you sign in as a provider, a short-lived proof of address control (<a href=${HOW_PATH}>how it works</a>) are kept in your browser's local storage. Neither ever leaves your device.</p>
  </section>`;

/** @param {(path: string) => void} go */
export const legalFooter = (go) => html`
  <footer class="legal">
    <a href=${TERMS_PATH} @click=${navigateOnClick(go, TERMS_PATH)}>Terms</a>
    <a href=${PRIVACY_PATH} @click=${navigateOnClick(go, PRIVACY_PATH)}>Privacy</a>
  </footer>`;
