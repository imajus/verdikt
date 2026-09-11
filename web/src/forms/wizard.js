// New-service onboarding: ENS is claimed before Arc registration, so a newly
// registered service can never begin life with conflicting ownership.
//
// Steps 1-3 are pure form state — no wallet involved, Back/Next only. Step 4
// reviews the draft and, on confirmation, runs the four transactions above
// in that fixed order from a resumable cursor (`done`): a step that fails
// leaves `done` where it stopped, and Retry resumes from there rather than
// from the top — a claimed subname is never re-claimed.
import { LitElement, html, nothing } from 'lit';
import { resolveServiceRecord } from '@verdikt/sdk';
import { claimSubname, publishSla, publishUrl, registerService } from '../actions.js';
import { describeSlaValidity } from './sla-editor.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The four transactions registration requires, in the order the module
 * comment above mandates. A pure builder so it's testable without mounting
 * the element: `run()` closures capture `deps` and the draft, nothing else.
 * @param {NonNullable<VerdiktWizard['deps']>} deps
 * @param {{ slug: string, url: string, sla: string }} draft
 */
export function buildExecutionSteps(deps, { slug, url, sla }) {
  return [
    {
      key: 'claim', label: `Claim ${slug}.verdikt.eth`, chain: /** @type {const} */ ('Sepolia'),
      ensure: deps.ensureSepolia,
      run: () => claimSubname({ walletClient: deps.walletClientFor('sepolia'), registrarAddress: deps.registrarAddress, slug, payTo: deps.account })
    },
    {
      key: 'register', label: `Register on Arc · ${deps.formatNativeUsdc(deps.depositAmount)}`, chain: /** @type {const} */ ('Arc'),
      ensure: deps.ensureArc,
      run: () => registerService({ walletClient: deps.walletClientFor('arc'), registryAddress: deps.registryAddress, slug, depositAmount: deps.depositAmount })
    },
    {
      key: 'url', label: 'Publish endpoint URL', chain: /** @type {const} */ ('Sepolia'),
      ensure: deps.ensureSepolia,
      run: () => publishUrl({ walletClient: deps.walletClientFor('sepolia'), slug, value: url.trim() })
    },
    {
      key: 'sla', label: 'Publish SLA', chain: /** @type {const} */ ('Sepolia'),
      ensure: deps.ensureSepolia,
      run: () => publishSla({ walletClient: deps.walletClientFor('sepolia'), slug, value: sla.trim() })
    }
  ];
}

export class VerdiktWizard extends LitElement {
  static properties = {
    deps: { attribute: false }, message: {}, step: { state: true }, slug: { state: true },
    availability: { state: true }, available: { state: true }, url: { state: true }, sla: { state: true },
    done: { state: true }, execError: { state: true }, pending: { state: true }, status: { state: true }
  };
  constructor() {
    super();
    /** @type {{account:string, registrarAddress:string, registryAddress:string, depositAmount:bigint, sepoliaRpcUrl:string, formatNativeUsdc:(v:bigint)=>string, walletClientFor:(chain:'arc'|'sepolia')=>{writeContract:Function,sendTransaction:Function}, ensureSepolia:()=>Promise<void>, ensureArc:()=>Promise<void>, onDone:()=>void}|null} */ this.deps = null;
    this.message = ''; this.step = 1; this.slug = ''; this.availability = ''; this.available = false;
    this.url = ''; this.sla = ''; this.done = 0; this.execError = ''; this.pending = false; this.status = '';
    this.checkToken = 0;
  }
  createRenderRoot() { return this; }
  clear() {
    this.deps = null;
    this.checkToken++;
    this.message = ''; this.step = 1; this.slug = ''; this.availability = ''; this.available = false;
    this.url = ''; this.sla = ''; this.done = 0; this.execError = ''; this.pending = false; this.status = '';
  }
  /** @param {number} step */
  goStep(step) { this.step = step; }
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
  /** @param {InputEvent} event */ editUrl(event) { this.url = /** @type {{value:string}} */ (/** @type {unknown} */ (event.currentTarget)).value; }
  /** @param {InputEvent} event */ editSla(event) { this.sla = /** @type {{value:string}} */ (/** @type {unknown} */ (event.currentTarget)).value; }
  get urlValid() { return /^https?:\/\//.test(this.url.trim()); }
  async execute() {
    const deps = this.deps;
    if (!deps) return;
    const steps = buildExecutionSteps(deps, { slug: this.slug, url: this.url, sla: this.sla });
    this.pending = true;
    this.execError = '';
    for (let i = this.done; i < steps.length; i++) {
      this.status = `${i + 1}/${steps.length} ${steps[i].label}…`;
      try {
        await steps[i].ensure();
        await steps[i].run();
        this.done = i + 1;
      } catch (error) {
        this.pending = false;
        this.execError = /** @type {Error} */ (error).message;
        this.status = '';
        return;
      }
    }
    this.pending = false;
    this.status = 'Done.';
    deps.onDone();
  }
  renderStep() {
    if (this.step === 1) return html`
      <wa-input id="wizard-slug" label="Slug" autocomplete="off" .value=${this.slug} placeholder="weather" @input=${this.editSlug}></wa-input>
      ${this.availability ? html`<p class="form-status" id="wizard-availability">${this.availability}</p>` : nothing}
      <div class="wizard-nav"><wa-button type="button" id="wizard-next-1" ?disabled=${!this.available} @click=${() => this.goStep(2)}>Next</wa-button></div>`;
    if (this.step === 2) return html`
      <wa-input id="wizard-url" label="Endpoint URL" type="url" autocomplete="off" placeholder="https://provider.example/api" .value=${this.url} @input=${this.editUrl}></wa-input>
      <div class="wizard-nav"><wa-button type="button" appearance="outlined" @click=${() => this.goStep(1)}>Back</wa-button><wa-button type="button" id="wizard-next-2" ?disabled=${!this.urlValid} @click=${() => this.goStep(3)}>Next</wa-button></div>`;
    if (this.step === 3) {
      const validity = describeSlaValidity(this.sla);
      return html`
        <wa-textarea id="wizard-sla" label="SLA (JSON)" spellcheck="false" rows="10" resize="vertical" .value=${this.sla} @input=${this.editSla}></wa-textarea>
        <p class="check ${validity.ok ? 'ok' : 'bad'}" id="wizard-sla-check"><i class="dot"></i>${validity.message}</p>
        <div class="wizard-nav"><wa-button type="button" appearance="outlined" @click=${() => this.goStep(2)}>Back</wa-button><wa-button type="button" id="wizard-next-3" ?disabled=${!validity.ok} @click=${() => this.goStep(4)}>Next</wa-button></div>`;
    }
    return this.renderReview();
  }
  renderReview() {
    const deps = /** @type {NonNullable<typeof this.deps>} */ (this.deps);
    const steps = buildExecutionSteps(deps, { slug: this.slug, url: this.url, sla: this.sla });
    return html`
      <dl class="wizard-review">
        <div><dt>Slug</dt><dd>${this.slug}.verdikt.eth</dd></div>
        <div><dt>Endpoint</dt><dd>${this.url.trim()}</dd></div>
        <div><dt>SLA</dt><dd>${describeSlaValidity(this.sla).message}</dd></div>
        <div><dt>Bond</dt><dd>${deps.formatNativeUsdc(deps.depositAmount)}</dd></div>
      </dl>
      ${this.done === 0 ? html`<div class="wizard-nav"><wa-button type="button" appearance="outlined" @click=${() => this.goStep(3)}>Back</wa-button><wa-button type="button" id="wizard-register" ?disabled=${this.pending} ?loading=${this.pending} @click=${this.execute}>Register service</wa-button></div>` : nothing}
      <ol class="wizard-progress">${steps.map((step, i) => html`<li class=${i < this.done ? 'done' : i === this.done && this.execError ? 'error' : ''}>${i + 1}/${steps.length} ${step.label} <small>${step.chain}</small></li>`)}</ol>
      ${this.execError ? html`<p class="form-status" id="wizard-status">Failed: ${this.execError}</p><wa-button type="button" id="wizard-retry" ?disabled=${this.pending} ?loading=${this.pending} @click=${this.execute}>Retry</wa-button>` : this.status ? html`<p class="form-status" id="wizard-status">${this.status}</p>` : nothing}`;
  }
  render() {
    if (this.message) return html`<p class="aside">${this.message}</p>`;
    if (!this.deps) return nothing;
    return html`<ol class="wizard-steps">
        <li class=${this.step >= 1 ? 'done' : ''}>1. Name</li>
        <li class=${this.step >= 2 ? 'done' : ''}>2. Endpoint</li>
        <li class=${this.step >= 3 ? 'done' : ''}>3. SLA</li>
        <li class=${this.step >= 4 ? 'done' : ''}>4. Review</li>
      </ol>${this.renderStep()}`;
  }
}

if (!customElements.get('verdikt-wizard')) customElements.define('verdikt-wizard', VerdiktWizard);
