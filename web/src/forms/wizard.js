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
import { navigateOnClick, serviceUrl } from '../router.js';
import { describeSlaValidity } from './sla-editor.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A keystroke-per-RPC-call availability check would spam the Sepolia
// endpoint on every letter typed; this is the pause after the last keystroke
// before the real lookup fires.
const SLUG_CHECK_DEBOUNCE_MS = 400;

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
    /** @type {{account:string, registrarAddress:string, registryAddress:string, depositAmount:bigint, sepoliaRpcUrl:string, formatNativeUsdc:(v:bigint)=>string, walletClientFor:(chain:'arc'|'sepolia')=>{writeContract:Function,sendTransaction:Function}, ensureSepolia:()=>Promise<void>, ensureArc:()=>Promise<void>, onDone:()=>void, go:(path:string)=>void, pushStep:(step:number)=>void, backStep:()=>void}|null} */ this.deps = null;
    this.message = ''; this.step = 1; this.slug = ''; this.availability = ''; this.available = false;
    this.url = ''; this.sla = ''; this.done = 0; this.execError = ''; this.pending = false; this.status = '';
    this.checkToken = 0;
    this.slugDebounceTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
  }
  createRenderRoot() { return this; }
  clear() {
    this.deps = null;
    this.checkToken++;
    clearTimeout(this.slugDebounceTimer ?? undefined);
    this.message = ''; this.step = 1; this.slug = ''; this.availability = ''; this.available = false;
    this.url = ''; this.sla = ''; this.done = 0; this.execError = ''; this.pending = false; this.status = '';
  }
  // The four steps share one URL, so each forward move records a same-URL
  // history entry and in-page Back walks that history rather than pushing a
  // third entry. Without this the browser's own Back leaves /register from
  // step 3 instead of returning to step 2, taking the draft with it.
  // `history` itself is main.js's to touch (router.js's header), so both
  // directions arrive as injected dependencies.
  /** @param {number} step */
  goStep(step) {
    this.step = step;
    this.deps?.pushStep(step);
  }
  stepBack() { this.deps?.backStep(); }
  /**
   * Apply a step carried by a popped history entry. Refused in two cases:
   * once a transaction has landed (`done > 0`), where the slug is frozen
   * because the remaining transactions target it; and on a wizard with no
   * draft, which is what navigating back to /register builds — the entry
   * still says "step 3" but the draft that step reviewed is gone.
   * @param {number} step
   */
  restoreStep(step) {
    if (this.done > 0) return;
    if (step > 1 && !this.slug) return;
    this.step = Math.min(Math.max(Math.trunc(step), 1), 4);
  }
  /** @param {InputEvent} event */
  editSlug(event) {
    this.slug = /** @type {{value:string}} */ (/** @type {unknown} */ (event.currentTarget)).value.trim();
    this.available = false;
    // Invalidate any check already scheduled or in flight for the previous
    // value — its result must never land after a keystroke has moved on.
    this.checkToken++;
    clearTimeout(this.slugDebounceTimer ?? undefined);
    if (!SLUG.test(this.slug)) { this.availability = 'Lowercase letters, digits and hyphens only.'; return; }
    this.availability = 'Checking…';
    this.slugDebounceTimer = setTimeout(() => this.checkAvailability(), SLUG_CHECK_DEBOUNCE_MS);
  }
  async checkAvailability() {
    const token = this.checkToken;
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
  /**
   * Run exactly one step, and only the one the cursor is on. Deliberately
   * not a loop over the remaining steps: a wallet raises its popup only
   * while the browser still holds transient user activation, which lasts a
   * few seconds after a click. Chaining the steps spends that activation on
   * the first one, so the chain switch before step 2 — arriving long after
   * the user finished approving step 1 — was queued behind the extension
   * badge instead of prompting, and surfaced as "switch to the required
   * network first" with nothing ever shown. One click per step keeps every
   * wallet interaction inside its own activation window.
   * @param {number} index
   */
  async runStep(index) {
    const deps = this.deps;
    if (!deps || index !== this.done || this.pending) return;
    const steps = buildExecutionSteps(deps, { slug: this.slug, url: this.url, sla: this.sla });
    const step = steps[index];
    this.pending = true;
    this.execError = '';
    this.status = '';
    try {
      await step.ensure();
      await step.run();
      this.done = index + 1;
      if (this.done === steps.length) {
        this.status = 'Done.';
        deps.onDone();
      }
    } catch (error) {
      this.execError = /** @type {Error} */ (error).message;
    } finally {
      this.pending = false;
    }
  }
  renderStep() {
    if (this.step === 1) return html`
      <wa-input id="wizard-slug" label="Slug" autocomplete="off" .value=${this.slug} placeholder="weather" @input=${this.editSlug}></wa-input>
      ${this.availability ? html`<p class="form-status" id="wizard-availability">${this.availability}</p>` : nothing}
      <div class="wizard-nav"><wa-button type="button" id="wizard-next-1" ?disabled=${!this.available} @click=${() => this.goStep(2)}>Next</wa-button></div>`;
    if (this.step === 2) return html`
      <wa-input id="wizard-url" label="Endpoint URL" type="url" autocomplete="off" placeholder="https://provider.example/api" .value=${this.url} @input=${this.editUrl}></wa-input>
      <div class="wizard-nav"><wa-button type="button" appearance="outlined" @click=${() => this.stepBack()}>Back</wa-button><wa-button type="button" id="wizard-next-2" ?disabled=${!this.urlValid} @click=${() => this.goStep(3)}>Next</wa-button></div>`;
    if (this.step === 3) {
      const validity = describeSlaValidity(this.sla);
      return html`
        <wa-textarea id="wizard-sla" label="SLA (JSON)" spellcheck="false" rows="10" resize="vertical" .value=${this.sla} @input=${this.editSla}></wa-textarea>
        <p class="check ${validity.ok ? 'ok' : 'bad'}" id="wizard-sla-check"><i class="dot"></i>${validity.message}</p>
        <div class="wizard-nav"><wa-button type="button" appearance="outlined" @click=${() => this.stepBack()}>Back</wa-button><wa-button type="button" id="wizard-next-3" ?disabled=${!validity.ok} @click=${() => this.goStep(4)}>Next</wa-button></div>`;
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
      ${this.done === 0 ? html`<div class="wizard-nav"><wa-button type="button" appearance="outlined" @click=${() => this.stepBack()}>Back</wa-button></div>` : nothing}
      <ol class="wizard-run">
        ${steps.map((step, i) => html`
          <li class=${i < this.done ? 'done' : i === this.done ? 'current' : 'later'}>
            <div class="run-row">
              <wa-button type="button" id=${`wizard-run-${step.key}`} ?disabled=${i !== this.done || this.pending} ?loading=${i === this.done && this.pending} appearance=${i === this.done ? 'accent' : 'outlined'} @click=${() => this.runStep(i)}>${i < this.done ? '✓ ' : ''}${step.label}</wa-button>
              <span class="chain">${step.chain}</span>
            </div>
            ${i === this.done && this.execError ? html`<p class="check bad" id="wizard-step-error"><i class="dot"></i>${this.execError}</p>` : nothing}
          </li>`)}
      </ol>
      ${this.done === steps.length ? html`<p class="form-status" id="wizard-status">${this.status}</p><wa-button id="wizard-view-service" href=${serviceUrl(this.slug)} @click=${navigateOnClick(deps.go, serviceUrl(this.slug))}>View your service →</wa-button>` : nothing}`;
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
