// New-service onboarding: ENS is claimed before Arc registration, so a newly
// registered service can never begin life with conflicting ownership.
import { LitElement, html, nothing } from 'lit';
import { resolveServiceRecord } from '@verdikt/sdk';
import { parseSla } from '@verdikt/sla';
import { claimSubname, publishSla, publishUrl, registerService } from '../actions.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class VerdiktWizard extends LitElement {
  static properties = {
    deps: { attribute: false }, message: {}, step: { state: true }, slug: { state: true },
    availability: { state: true }, available: { state: true }, pending: { state: true },
    status: { state: true }, url: { state: true }, sla: { state: true }
  };
  constructor() {
    super();
    /** @type {{account:string, registrarAddress:string, registryAddress:string, depositAmount:bigint, sepoliaRpcUrl:string, formatNativeUsdc:(v:bigint)=>string, walletClientFor:(chain:'arc'|'sepolia')=>{writeContract:Function,sendTransaction:Function}, ensureSepolia:()=>Promise<void>, ensureArc:()=>Promise<void>, onDone:()=>void}|null} */ this.deps = null;
    this.message = ''; this.step = 1; this.slug = ''; this.availability = ''; this.available = false; this.pending = false; this.status = ''; this.url = ''; this.sla = '';
    this.checkToken = 0;
  }
  createRenderRoot() { return this; }
  /** @param {InputEvent} event */
  editSlug(event) {
    this.slug = /** @type {{value:string}} */ (/** @type {unknown} */ (event.currentTarget)).value.trim();
    this.checkAvailability();
  }
  async checkAvailability() {
    const token = ++this.checkToken;
    this.available = false;
    if (!SLUG.test(this.slug)) { this.availability = 'Lowercase letters, digits and hyphens only.'; return; }
    this.availability = 'Checking…';
    try {
      const record = await resolveServiceRecord(this.slug, { rpcUrl: /** @type {NonNullable<typeof this.deps>} */ (this.deps).sepoliaRpcUrl });
      if (token !== this.checkToken) return;
      this.available = !record.owner;
      this.availability = record.owner ? `Already claimed by ${record.owner}.` : 'Available.';
    } catch (error) {
      if (token !== this.checkToken) return;
      this.availability = `Could not check availability: ${/** @type {Error} */ (error).message}`;
    }
  }
  async claim() {
    if (!this.deps || !this.available) return;
    this.pending = true; this.status = 'Sending…';
    try {
      await this.deps.ensureSepolia();
      await claimSubname({ walletClient: this.deps.walletClientFor('sepolia'), registrarAddress: this.deps.registrarAddress, slug: this.slug, payTo: this.deps.account });
      this.step = 2; this.status = '';
    } catch (error) { this.status = `Failed: ${/** @type {Error} */ (error).message}`; }
    finally { this.pending = false; }
  }
  async register() {
    if (!this.deps) return;
    this.pending = true; this.status = 'Sending…';
    try {
      await this.deps.ensureArc();
      await registerService({ walletClient: this.deps.walletClientFor('arc'), registryAddress: this.deps.registryAddress, slug: this.slug, depositAmount: this.deps.depositAmount });
      this.step = 3; this.status = '';
    } catch (error) { this.status = `Failed: ${/** @type {Error} */ (error).message}`; }
    finally { this.pending = false; }
  }
  /** @param {InputEvent} event */ editUrl(event) { this.url = /** @type {{value:string}} */ (/** @type {unknown} */ (event.currentTarget)).value; }
  /** @param {InputEvent} event */ editSla(event) { this.sla = /** @type {{value:string}} */ (/** @type {unknown} */ (event.currentTarget)).value; }
  get slaValidity() {
    if (!this.sla.trim()) return { ok: false, message: 'Paste an SLA to validate it.' };
    try { const parsed = parseSla(this.sla.trim()); return { ok: true, message: `Valid. ${parsed.clauses.length} clause(s).` }; }
    catch (error) { return { ok: false, message: /** @type {Error} */ (error).message }; }
  }
  async publish() {
    if (!this.deps || !this.slaValidity.ok || !/^https?:\/\//.test(this.url.trim())) return;
    this.pending = true; this.status = 'Publishing URL…';
    try {
      await this.deps.ensureSepolia();
      const walletClient = this.deps.walletClientFor('sepolia');
      await publishUrl({ walletClient, slug: this.slug, value: this.url.trim() });
      this.status = 'Publishing SLA…';
      await publishSla({ walletClient, slug: this.slug, value: this.sla.trim() });
      this.status = 'Done.'; this.deps.onDone();
    } catch (error) { this.status = `Failed: ${/** @type {Error} */ (error).message}`; }
    finally { this.pending = false; }
  }
  renderStep() {
    if (this.step === 1) return html`<wa-input id="wizard-slug" label="Slug" autocomplete="off" .value=${this.slug} placeholder="weather" @input=${this.editSlug}></wa-input>
      ${this.availability ? html`<p class="form-status" id="wizard-availability">${this.availability}</p>` : nothing}<wa-button type="button" id="wizard-claim" ?disabled=${!this.available || this.pending} ?loading=${this.pending} @click=${this.claim}>Claim on Sepolia</wa-button>`;
    if (this.step === 2) return html`<p class="aside">Registering "${this.slug}" for ${/** @type {NonNullable<typeof this.deps>} */ (this.deps).formatNativeUsdc(/** @type {NonNullable<typeof this.deps>} */ (this.deps).depositAmount)}.</p><wa-button type="button" id="wizard-register" ?disabled=${this.pending} ?loading=${this.pending} @click=${this.register}>Register on Arc</wa-button>`;
    const validity = this.slaValidity;
    return html`<wa-input id="wizard-url" label="Endpoint URL" type="url" autocomplete="off" placeholder="https://provider.example/api" .value=${this.url} @input=${this.editUrl}></wa-input>
      <wa-textarea id="wizard-sla" label="SLA (JSON)" spellcheck="false" rows="10" resize="vertical" .value=${this.sla} @input=${this.editSla}></wa-textarea>
      <p class="check ${validity.ok ? 'ok' : 'bad'}" id="wizard-sla-check"><i class="dot"></i>${validity.message}</p><wa-button type="button" id="wizard-publish" ?disabled=${this.pending || !validity.ok || !/^https?:\/\//.test(this.url.trim())} ?loading=${this.pending} @click=${this.publish}>Publish &amp; finish</wa-button>`;
  }
  render() {
    if (this.message) return html`<p class="aside">${this.message}</p>`;
    if (!this.deps) return nothing;
    return html`<ol class="wizard-steps"><li class=${this.step >= 1 ? 'done' : ''}>1. Claim the subname</li><li class=${this.step >= 2 ? 'done' : ''}>2. Register on Arc</li><li class=${this.step >= 3 ? 'done' : ''}>3. Publish SLA &amp; URL</li></ol>${this.renderStep()}${this.status ? html`<p class="form-status" id="wizard-status">${this.status}</p>` : nothing}`;
  }
}

if (!customElements.get('verdikt-wizard')) customElements.define('verdikt-wizard', VerdiktWizard);
