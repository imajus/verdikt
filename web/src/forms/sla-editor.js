import { LitElement, html, nothing } from 'lit';
import { publishSla } from '../actions.js';
import { formatTxError } from '../format.js';
import { describeSlaValidity } from './sla-validity.js';
import './sla-composer.js';

export { describeSlaValidity };

export class VerdiktSlaEditor extends LitElement {
  static properties = { listing: { attribute: false }, deps: { attribute: false }, message: {}, draft: { state: true }, status: { state: true }, pending: { state: true } };
  constructor() {
    super();
    /** @type {{slug:string, slaRaw:string|null, history?: Array<{ failedClauseId: string | null }>}|null} */ this.listing = null;
    /** @type {{walletClientFor:()=>{sendTransaction:Function}, ensureSepolia:()=>Promise<void>}|null} */ this.deps = null;
    this.message = ''; this.draft = ''; this.status = ''; this.pending = false;
  }
  createRenderRoot() { return this; }
  // The provider view can remain mounted while the connected wallet changes.
  // Do not leave a previous provider's draft or transaction dependencies
  // attached to a component that no longer has a selected service.
  clear() {
    this.listing = null;
    this.deps = null;
    this.message = '';
    this.draft = '';
    this.status = '';
    this.pending = false;
  }
  /** @param {Map<PropertyKey, unknown>} changed */
  willUpdate(changed) {
    if (changed.has('listing') && this.listing) { this.draft = this.listing.slaRaw ?? ''; this.status = ''; }
  }
  /** @param {CustomEvent<{ value: string }>} event */ edit(event) { this.draft = event.detail.value; }
  /** The draft differs from what the chain holds — the only case Publish or Discard means anything. */
  get changed() { return this.draft.trim() !== (this.listing?.slaRaw ?? '').trim(); }
  discard() { this.draft = this.listing?.slaRaw ?? ''; this.status = ''; }
  async publish() {
    if (!this.listing || !this.deps || !describeSlaValidity(this.draft).ok) return;
    this.pending = true; this.status = 'Sending…';
    try {
      await this.deps.ensureSepolia();
      const { hash } = await publishSla({ walletClient: this.deps.walletClientFor(), slug: this.listing.slug, value: this.draft.trim() });
      this.status = `Sent: ${hash}`;
    } catch (error) { this.status = `Failed: ${formatTxError(error)}`; }
    finally { this.pending = false; }
  }
  render() {
    if (this.message) return html`<p class="aside">${this.message}</p>`;
    if (!this.listing || !this.deps) return nothing;
    const validity = describeSlaValidity(this.draft);
    return html`<verdikt-sla-composer id="sla-composer" .value=${this.draft} .history=${this.listing.history ?? []} @sla-change=${this.edit}></verdikt-sla-composer>
      <div class="composer-actions">
        <wa-button type="button" id="sla-publish" ?disabled=${!validity.ok || !this.changed || this.pending} ?loading=${this.pending} @click=${this.publish}>Publish SLA</wa-button>
        ${this.changed && !this.pending ? html`<wa-button type="button" id="sla-discard" appearance="outlined" @click=${this.discard}>Discard changes</wa-button>` : nothing}
      </div>
      ${this.status ? html`<p class="form-status" id="sla-status">${this.status}</p>` : nothing}`;
  }
}

if (!customElements.get('verdikt-sla-editor')) customElements.define('verdikt-sla-editor', VerdiktSlaEditor);
