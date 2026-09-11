import { LitElement, html, nothing } from 'lit';
import { retireService, topUpBond } from '../actions.js';
import { formatTxError } from '../format.js';

/** @param {string} input @returns {bigint|null} */
function parseUsdcToNativeUnits(input) {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0').slice(0, 18) || '0');
}

export class VerdiktBondControls extends LitElement {
  static properties = { listing: { attribute: false }, deps: { attribute: false }, message: {}, topUp: { state: true }, confirmation: { state: true }, topUpStatus: { state: true }, retireStatus: { state: true }, topUpPending: { state: true }, retirePending: { state: true } };
  constructor() {
    super();
    /** @type {{slug:string, serviceId:string, status:string, deposit:bigint}|null} */ this.listing = null;
    /** @type {{walletClientFor:()=>{writeContract:Function}, registryAddress:string, depositAmount:bigint, formatNativeUsdc:(v:bigint)=>string, ensureArc:()=>Promise<void>}|null} */ this.deps = null;
    this.message = ''; this.topUp = ''; this.confirmation = ''; this.topUpStatus = ''; this.retireStatus = ''; this.topUpPending = false; this.retirePending = false;
  }
  createRenderRoot() { return this; }
  // See VerdiktSlaEditor's clear(): a wallet change must never leave this
  // component able to submit against a service owned by the prior account.
  clear() {
    this.listing = null;
    this.deps = null;
    this.message = '';
    this.topUp = '';
    this.confirmation = '';
    this.topUpStatus = '';
    this.retireStatus = '';
    this.topUpPending = false;
    this.retirePending = false;
  }
  /** @param {InputEvent} event */ editTopUp(event) { this.topUp = /** @type {{value:string}} */ (/** @type {unknown} */ (event.currentTarget)).value; }
  /** @param {InputEvent} event */ editConfirmation(event) { this.confirmation = /** @type {{value:string}} */ (/** @type {unknown} */ (event.currentTarget)).value; }
  async submitTopUp() {
    if (!this.listing || !this.deps) return;
    const amount = parseUsdcToNativeUnits(this.topUp);
    if (amount === null) { this.topUpStatus = 'Enter a valid amount.'; return; }
    this.topUpPending = true; this.topUpStatus = 'Sending…';
    try {
      await this.deps.ensureArc();
      const { hash } = await topUpBond({ walletClient: this.deps.walletClientFor(), registryAddress: this.deps.registryAddress, serviceId: this.listing.serviceId, amount });
      this.topUpStatus = `Sent: ${hash}`;
    } catch (error) { this.topUpStatus = `Failed: ${formatTxError(error)}`; }
    finally { this.topUpPending = false; }
  }
  async retire() {
    if (!this.listing || !this.deps || this.confirmation !== this.listing.slug) return;
    this.retirePending = true; this.retireStatus = 'Sending…';
    try {
      await this.deps.ensureArc();
      const { hash } = await retireService({ walletClient: this.deps.walletClientFor(), registryAddress: this.deps.registryAddress, serviceId: this.listing.serviceId });
      this.retireStatus = `Sent: ${hash}`;
    } catch (error) { this.retireStatus = `Failed: ${formatTxError(error)}`; }
    finally { this.retirePending = false; }
  }
  render() {
    if (this.message) return html`<p class="aside">${this.message}</p>`;
    if (!this.listing || !this.deps) return nothing;
    const suspended = this.listing.status === 'SUSPENDED';
    const shortfall = this.deps.depositAmount > this.listing.deposit ? this.deps.depositAmount - this.listing.deposit : 0n;
    return html`<div class="bond-form"><wa-input id="topup-amount" label="Top up (USDC)" inputmode="decimal" placeholder="0.0" .value=${this.topUp} @input=${this.editTopUp}></wa-input>
        ${suspended ? html`<p class="aside warn">Suspended — needs ${this.deps.formatNativeUsdc(shortfall)} more to reinstate (reinstatement requires the bond back at full, not merely above zero).</p>` : nothing}
        <wa-button type="button" id="topup-send" ?disabled=${this.topUpPending} ?loading=${this.topUpPending} @click=${this.submitTopUp}>Top up</wa-button>${this.topUpStatus ? html`<p class="form-status">${this.topUpStatus}</p>` : nothing}</div>
      <div class="retire-form"><p class="aside warn">Retiring is permanent: "${this.listing.slug}" can never be registered again, the remaining bond returns to you, and the listing stops taking calls.</p>
        <wa-input id="retire-confirm" label=${`Type "${this.listing.slug}" to confirm`} autocomplete="off" .value=${this.confirmation} @input=${this.editConfirmation}></wa-input>
        <wa-button type="button" id="retire-send" variant="danger" ?disabled=${suspended || this.retirePending || this.confirmation !== this.listing.slug} ?loading=${this.retirePending} title=${suspended ? 'Reverts while suspended — top up first' : ''} @click=${this.retire}>Retire service</wa-button>${this.retireStatus ? html`<p class="form-status">${this.retireStatus}</p>` : nothing}</div>`;
  }
}

if (!customElements.get('verdikt-bond-controls')) customElements.define('verdikt-bond-controls', VerdiktBondControls);
export const __parseUsdcToNativeUnitsForTests = parseUsdcToNativeUnits;
