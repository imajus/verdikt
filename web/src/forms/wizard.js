// New-service onboarding: three wallet-signed transactions, ENS before Arc.
//
// ENS first is deliberate (docs/superpowers/specs/2026-09-08-provider-console-design.md
// §5): by the time the Arc registration happens, the subname already exists
// and already agrees with the caller, so the proxy's ownership check
// (checkOwnership) can never flag a service this wizard just created.
//
// State is derived from the two chains on every render rather than kept in
// localStorage: a refresh or a dropped wallet mid-flow re-enters at whichever
// step the chains say is next, because that IS the state.

import { resolveServiceRecord } from '@verdikt/sdk';
import { parseSla } from '@verdikt/sla';
import { claimSubname, publishSla, publishUrl, registerService } from '../actions.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * @param {HTMLElement} container
 * @param {{
 *   account: string,
 *   registrarAddress: string,
 *   registryAddress: string,
 *   depositAmount: bigint,
 *   sepoliaRpcUrl: string,
 *   formatNativeUsdc: (v: bigint) => string,
 *   walletClientFor: () => { writeContract: Function, sendTransaction: Function },
 *   ensureSepolia: () => Promise<void>,
 *   ensureArc: () => Promise<void>,
 *   onDone: () => void
 * }} deps
 */
export function mountWizard(container, deps) {
  /** @type {{ step: 1|2|3, slug: string, claimed: boolean|null, registered: boolean|null }} */
  const state = { step: 1, slug: '', claimed: null, registered: null };
  const draw = () => {
    container.innerHTML = `
      <ol class="wizard-steps">
        <li class="${state.step >= 1 ? 'done' : ''}">1. Claim the subname</li>
        <li class="${state.step >= 2 ? 'done' : ''}">2. Register on Arc</li>
        <li class="${state.step >= 3 ? 'done' : ''}">3. Publish SLA &amp; URL</li>
      </ol>
      <div id="wizard-step"></div>`;
    const stepMount = /** @type {HTMLElement} */ (container.querySelector('#wizard-step'));
    if (state.step === 1) drawStep1(stepMount);
    else if (state.step === 2) drawStep2(stepMount);
    else drawStep3(stepMount);
  };
  /** @param {HTMLElement} mount */
  const drawStep1 = (mount) => {
    mount.innerHTML = `
      <label for="wizard-slug">Slug</label>
      <input id="wizard-slug" type="text" autocomplete="off" value="${state.slug}" placeholder="weather" />
      <p class="form-status" id="wizard-availability" hidden></p>
      <button type="button" id="wizard-claim" disabled>Claim on Sepolia</button>
      <p class="form-status" id="wizard-status" hidden></p>`;
    const input = /** @type {HTMLInputElement} */ (mount.querySelector('#wizard-slug'));
    const availability = /** @type {HTMLElement} */ (mount.querySelector('#wizard-availability'));
    const claimButton = /** @type {HTMLButtonElement} */ (mount.querySelector('#wizard-claim'));
    const status = /** @type {HTMLElement} */ (mount.querySelector('#wizard-status'));
    let checkToken = 0;
    const checkAvailability = async () => {
      const slug = input.value.trim();
      const token = ++checkToken;
      if (!SLUG.test(slug)) {
        availability.hidden = false;
        availability.textContent = 'Lowercase letters, digits and hyphens only.';
        claimButton.disabled = true;
        return;
      }
      availability.hidden = false;
      availability.textContent = 'Checking…';
      claimButton.disabled = true;
      try {
        // rpcUrl must be passed explicitly and truthy: packages/sdk/ens.js
        // falls back to packages/sdk/env.js's env(), which reads
        // `process.env` directly — undefined in a Vite browser bundle, so an
        // omitted rpcUrl here would throw ReferenceError: process is not
        // defined the moment a slug is typed. web/src/source.js already
        // avoids this the same way, for the same reason.
        const record = await resolveServiceRecord(slug, { rpcUrl: deps.sepoliaRpcUrl });
        if (token !== checkToken) return;
        if (record.owner) {
          availability.textContent = `Already claimed by ${record.owner}.`;
          claimButton.disabled = true;
        } else {
          availability.textContent = 'Available.';
          claimButton.disabled = false;
        }
      } catch (error) {
        if (token !== checkToken) return;
        availability.textContent = `Could not check availability: ${/** @type {Error} */ (error).message}`;
        claimButton.disabled = true;
      }
    };
    input.addEventListener('input', () => {
      state.slug = input.value.trim();
      checkAvailability();
    });
    claimButton.addEventListener('click', async () => {
      claimButton.disabled = true;
      status.hidden = false;
      status.textContent = 'Sending…';
      try {
        await deps.ensureSepolia();
        const walletClient = deps.walletClientFor();
        await claimSubname({ walletClient, registrarAddress: deps.registrarAddress, slug: state.slug, payTo: deps.account });
        state.step = 2;
        draw();
      } catch (error) {
        status.textContent = `Failed: ${/** @type {Error} */ (error).message}`;
        claimButton.disabled = false;
      }
    });
  };
  /** @param {HTMLElement} mount */
  const drawStep2 = (mount) => {
    mount.innerHTML = `
      <p class="aside">Registering "${state.slug}" for ${deps.formatNativeUsdc(deps.depositAmount)}.</p>
      <button type="button" id="wizard-register">Register on Arc</button>
      <p class="form-status" id="wizard-status" hidden></p>`;
    const button = /** @type {HTMLButtonElement} */ (mount.querySelector('#wizard-register'));
    const status = /** @type {HTMLElement} */ (mount.querySelector('#wizard-status'));
    button.addEventListener('click', async () => {
      button.disabled = true;
      status.hidden = false;
      status.textContent = 'Sending…';
      try {
        await deps.ensureArc();
        const walletClient = deps.walletClientFor();
        await registerService({ walletClient, registryAddress: deps.registryAddress, slug: state.slug, depositAmount: deps.depositAmount });
        state.step = 3;
        draw();
      } catch (error) {
        status.textContent = `Failed: ${/** @type {Error} */ (error).message}`;
        button.disabled = false;
      }
    });
  };
  /** @param {HTMLElement} mount */
  const drawStep3 = (mount) => {
    mount.innerHTML = `
      <label for="wizard-url">Endpoint URL</label>
      <input id="wizard-url" type="text" autocomplete="off" placeholder="https://provider.example/api" />
      <label for="wizard-sla">SLA (JSON)</label>
      <textarea id="wizard-sla" spellcheck="false" rows="10"></textarea>
      <p class="check bad" id="wizard-sla-check"><i class="dot"></i>Paste an SLA to validate it.</p>
      <button type="button" id="wizard-publish" disabled>Publish &amp; finish</button>
      <p class="form-status" id="wizard-status" hidden></p>`;
    const urlInput = /** @type {HTMLInputElement} */ (mount.querySelector('#wizard-url'));
    const slaInput = /** @type {HTMLTextAreaElement} */ (mount.querySelector('#wizard-sla'));
    const check = /** @type {HTMLElement} */ (mount.querySelector('#wizard-sla-check'));
    const button = /** @type {HTMLButtonElement} */ (mount.querySelector('#wizard-publish'));
    const status = /** @type {HTMLElement} */ (mount.querySelector('#wizard-status'));
    const validate = () => {
      const source = slaInput.value.trim();
      const urlOk = /^https?:\/\//.test(urlInput.value.trim());
      if (!source) {
        check.className = 'check bad';
        check.textContent = 'Paste an SLA to validate it.';
        button.disabled = true;
        return;
      }
      try {
        const parsed = parseSla(source);
        check.className = 'check ok';
        check.textContent = `Valid. ${parsed.clauses.length} clause(s).`;
        button.disabled = !urlOk;
      } catch (error) {
        check.className = 'check bad';
        check.textContent = /** @type {Error} */ (error).message;
        button.disabled = true;
      }
    };
    urlInput.addEventListener('input', validate);
    slaInput.addEventListener('input', validate);
    button.addEventListener('click', async () => {
      button.disabled = true;
      status.hidden = false;
      status.textContent = 'Publishing URL…';
      try {
        await deps.ensureSepolia();
        const walletClient = deps.walletClientFor();
        await publishUrl({ walletClient, slug: state.slug, value: urlInput.value.trim() });
        status.textContent = 'Publishing SLA…';
        await publishSla({ walletClient, slug: state.slug, value: slaInput.value.trim() });
        status.textContent = 'Done.';
        deps.onDone();
      } catch (error) {
        status.textContent = `Failed: ${/** @type {Error} */ (error).message}`;
        button.disabled = false;
      }
    });
  };
  draw();
}
