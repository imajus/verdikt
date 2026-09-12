// The one address display the dashboard uses everywhere an address appears —
// provider, payTo, payer, connected wallet (issue #69). Two rules, in order:
//
//   - The base state is always the truncated form `0x1234…5678`. The full
//     address never appears as text, resolved or not — only ever behind this
//     element's own `title` tooltip. A resolved ENS primary name is strictly
//     additive on top of that truncated fallback, not a replacement for it
//     that then needs its own full-address escape hatch.
//   - Resolution is progressive enhancement: the truncated form paints first,
//     and an ENS primary name swaps in if and when one resolves. A resolver
//     that is slow, unreachable, or simply has nothing for this address
//     leaves the truncated form exactly where it started — never a loading
//     state worth showing, and never an error worth surfacing here.
//
// A custom element rather than a plain render function because resolution is
// asynchronous and the surrounding page is a stack of pure functions of
// already-loaded data (`detailTemplate` and friends in lit-app.js): giving
// each address its own small stateful component is what lets one row's
// resolution finish without re-rendering the page around it, the same reason
// `<verdikt-sla-editor>` and `<verdikt-bond-controls>` are elements and not
// functions.

import { LitElement, html, nothing } from 'lit';
import { DEFAULT_SEPOLIA_RPC, resolveAddressName } from '@verdikt/sdk';
import { copyButton } from './copy.js';

// Primary names change far less often than anything else this dashboard
// reads off a chain, so the cache in `resolveAddressName` can hold on to one
// for a long time without a stale result being likely to matter.
const CACHE_TTL_MS = 10 * 60 * 1000;

// Always a defined string, never `undefined`, so a caller that leaves
// VITE_SEPOLIA_RPC_URL unset in live mode still resolves through the same
// public endpoint the rest of the dashboard falls back to, rather than
// tripping `resolveAddressName`'s own `process.env` fallback — which has no
// business running inside a browser bundle.
const SEPOLIA_RPC_URL = (import.meta.env?.VITE_SEPOLIA_RPC_URL || '').trim() || DEFAULT_SEPOLIA_RPC;

/**
 * `0x1234…5678` — six leading characters (the `0x` plus four hex digits),
 * four trailing. The shape a wallet's own address picker already uses, kept
 * as the one truncation this dashboard shows rather than the tighter
 * `shortHex` (`format.js`) built for a request id, which has no ENS identity
 * to resolve and stays on its own format.
 * @param {string} address
 */
const truncate = (address) => (typeof address === 'string' && address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : String(address));

export class VerdiktAddress extends LitElement {
  static properties = { address: {}, copy: { type: Boolean }, resolve: { type: Boolean }, name: { state: true } };
  constructor() {
    super();
    /** @type {string|null} */ this.address = null;
    this.copy = false;
    // Off in demo mode (call sites pass `?resolve=${mode === 'live'}`):
    // seeded addresses have no real ENS identity, and resolving them would
    // still be a live network call from a page whose entire point is that it
    // is showing nothing live.
    this.resolve = true;
    /** @type {string|null} */ this.name = null;
    this._token = 0;
  }
  createRenderRoot() { return this; }
  /** @param {Map<string, unknown>} changed */
  willUpdate(changed) {
    if (!changed.has('address') && !changed.has('resolve')) return;
    this.name = null;
    const address = this.address;
    if (!this.resolve || !address) return;
    // Races a fast address change against a slow lookup: only the most
    // recent call may still write `this.name` when it settles.
    const token = ++this._token;
    resolveAddressName(address, { rpcUrl: SEPOLIA_RPC_URL, cacheTtlMs: CACHE_TTL_MS }).then(
      (resolved) => { if (token === this._token) this.name = resolved; },
      // An unreachable resolver is not a failure state worth showing here —
      // the truncated address it leaves in place is always a valid answer.
      () => {}
    );
  }
  render() {
    if (!this.address) return nothing;
    const label = this.name ?? truncate(this.address);
    return html`<span class="address-view"><code title=${this.address}>${label}</code>${this.copy ? copyButton(this.address) : nothing}</span>`;
  }
}

if (!customElements.get('verdikt-address')) customElements.define('verdikt-address', VerdiktAddress);
