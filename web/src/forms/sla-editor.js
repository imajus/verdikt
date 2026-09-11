import { LitElement, html, nothing } from 'lit';
import { parseSla } from '@verdikt/sla';
import { publishSla } from '../actions.js';
import { formatTxError } from '../format.js';

/** @param {string} source @returns {{ ok: boolean, message: string }} */
export function describeSlaValidity(source) {
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, message: 'Paste an SLA to validate it.' };
  try {
    const parsed = parseSla(trimmed);
    return { ok: true, message: `Valid. ${parsed.clauses.length} clause(s); the verifier would enforce all of them.` };
  } catch (error) {
    return { ok: false, message: /** @type {Error} */ (error).message };
  }
}

export class VerdiktSlaEditor extends LitElement {
  static properties = { listing: { attribute: false }, deps: { attribute: false }, message: {}, draft: { state: true }, status: { state: true }, pending: { state: true } };
  constructor() {
    super();
    /** @type {{slug:string, slaRaw:string|null}|null} */ this.listing = null;
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
  /** @param {InputEvent} event */ edit(event) { this.draft = /** @type {{value:string}} */ (/** @type {unknown} */ (event.currentTarget)).value; }
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
    return html`<wa-textarea id="sla-draft" label="SLA (JSON)" spellcheck="false" rows="14" resize="vertical" .value=${this.draft} @input=${this.edit}></wa-textarea>
      <p class="check ${validity.ok ? 'ok' : 'bad'}" id="sla-check"><i class="dot"></i>${validity.message}</p>
      <wa-button type="button" id="sla-publish" ?disabled=${!validity.ok || this.pending} ?loading=${this.pending} @click=${this.publish}>Publish SLA</wa-button>
      ${this.status ? html`<p class="form-status" id="sla-status">${this.status}</p>` : nothing}`;
  }
}

if (!customElements.get('verdikt-sla-editor')) customElements.define('verdikt-sla-editor', VerdiktSlaEditor);
