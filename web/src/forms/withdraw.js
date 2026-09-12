import { LitElement, html, nothing } from 'lit';
import { withdrawRefund } from '../actions.js';
import { formatTxError } from '../format.js';

/**
 * `/withdraw`'s own mount: the connected wallet's credited balance, read
 * fresh off the registry rather than off anything in the marketplace read
 * (a payer is not a listing), and collected with `withdraw()`.
 *
 * Mirrors `VerdiktBondControls`/`VerdiktSlaEditor`'s shape — `deps` carries
 * everything chain-shaped, main.js owns wiring it to the connected account —
 * except the data it acts on is not pushed in from a prior fetch: `deps.getOwed`
 * is called here, keyed to whichever `account`/`deps` pair is current when it
 * resolves, so a wallet switch mid-read can never write a stale balance over a
 * newer one.
 */
export class VerdiktWithdraw extends LitElement {
  static properties = { account: {}, deps: { attribute: false }, owed: { state: true }, status: { state: true }, pending: { state: true } };
  constructor() {
    super();
    /** @type {string|null} */ this.account = null;
    /** @type {{walletClientFor:()=>{writeContract:Function}, registryAddress:string, ensureArc:()=>Promise<void>, getOwed:(address:string)=>Promise<bigint>, formatNativeUsdc:(v:bigint)=>string}|null} */
    this.deps = null;
    /** @type {bigint|null} */ this.owed = null;
    this.status = '';
    this.pending = false;
  }
  createRenderRoot() { return this; }
  // A wallet change must never leave this showing a balance read for the
  // account that just disconnected.
  clear() {
    this.account = null;
    this.deps = null;
    this.owed = null;
    this.status = '';
    this.pending = false;
  }
  /** @param {Map<PropertyKey, unknown>} changed */
  willUpdate(changed) {
    if ((changed.has('account') || changed.has('deps')) && this.account && this.deps) {
      this.owed = null;
      this.status = '';
      this.refresh();
    }
  }
  async refresh() {
    const account = this.account;
    const deps = this.deps;
    if (!account || !deps) return;
    try {
      const owed = await deps.getOwed(account);
      if (this.account === account && this.deps === deps) this.owed = owed;
    } catch (error) {
      if (this.account === account && this.deps === deps) this.status = `Could not read your balance: ${formatTxError(error)}`;
    }
  }
  async withdraw() {
    if (!this.account || !this.deps || !this.owed) return;
    this.pending = true; this.status = 'Sending…';
    try {
      await this.deps.ensureArc();
      const { hash } = await withdrawRefund({ walletClient: this.deps.walletClientFor(), registryAddress: this.deps.registryAddress });
      this.status = `Sent: ${hash}`;
      await this.refresh();
    } catch (error) { this.status = `Failed: ${formatTxError(error)}`; }
    finally { this.pending = false; }
  }
  render() {
    if (!this.account || !this.deps) return nothing;
    return html`
      <p>Credited to <code>${this.account}</code>: <b>${this.owed === null ? 'reading…' : this.deps.formatNativeUsdc(this.owed)}</b></p>
      <wa-button type="button" id="withdraw-send" ?disabled=${!this.owed || this.pending} ?loading=${this.pending} @click=${this.withdraw}>Withdraw</wa-button>
      ${this.status ? html`<p class="form-status" id="withdraw-status">${this.status}</p>` : nothing}`;
  }
}

if (!customElements.get('verdikt-withdraw')) customElements.define('verdikt-withdraw', VerdiktWithdraw);
