// Top-up and retire, as two small mounted forms sharing one container. Retire
// is `deregister` — one-way (VerdiktRegistry.sol: the slug can never be
// registered again) — so it is named "Retire", not "Deactivate", and gated
// behind typing the slug back.

import { retireService, topUpBond } from '../actions.js';

/**
 * @param {HTMLElement} container
 * @param {{ slug: string, serviceId: string, status: string, deposit: bigint }} listing
 * @param {{ walletClientFor: () => { writeContract: Function }, registryAddress: string, depositAmount: bigint, formatNativeUsdc: (v: bigint) => string, ensureArc: () => Promise<void> }} deps
 */
export function mountBondControls(container, listing, deps) {
  const shortfall = deps.depositAmount > listing.deposit ? deps.depositAmount - listing.deposit : 0n;
  const suspended = listing.status === 'SUSPENDED';
  container.innerHTML = `
    <div class="bond-form">
      <label for="topup-amount">Top up (USDC)</label>
      <input id="topup-amount" type="text" inputmode="decimal" placeholder="0.0" />
      ${
        suspended
          ? `<p class="aside warn">Suspended — needs ${deps.formatNativeUsdc(shortfall)} more to reinstate (reinstatement requires the bond back at full, not merely above zero).</p>`
          : ''
      }
      <button type="button" id="topup-send">Top up</button>
      <p class="form-status" id="topup-status" hidden></p>
    </div>
    <div class="retire-form">
      <p class="aside warn">
        Retiring is permanent: "${escapeHtml(listing.slug)}" can never be registered again, the remaining bond
        returns to you, and the listing stops taking calls.
      </p>
      <label for="retire-confirm">Type "${escapeHtml(listing.slug)}" to confirm</label>
      <input id="retire-confirm" type="text" autocomplete="off" />
      <button type="button" id="retire-send" disabled ${suspended ? 'title="Reverts while suspended — top up first"' : ''}>Retire service</button>
      <p class="form-status" id="retire-status" hidden></p>
    </div>`;
  const topUpInput = /** @type {HTMLInputElement} */ (container.querySelector('#topup-amount'));
  const topUpButton = /** @type {HTMLButtonElement} */ (container.querySelector('#topup-send'));
  const topUpStatus = /** @type {HTMLElement} */ (container.querySelector('#topup-status'));
  topUpButton.addEventListener('click', async () => {
    const amount = parseUsdcToNativeUnits(topUpInput.value);
    if (amount === null) {
      topUpStatus.hidden = false;
      topUpStatus.textContent = 'Enter a valid amount.';
      return;
    }
    topUpButton.disabled = true;
    topUpStatus.hidden = false;
    topUpStatus.textContent = 'Sending…';
    try {
      await deps.ensureArc();
      const walletClient = deps.walletClientFor();
      const { hash } = await topUpBond({ walletClient, registryAddress: deps.registryAddress, serviceId: listing.serviceId, amount });
      topUpStatus.textContent = `Sent: ${hash}`;
    } catch (error) {
      topUpStatus.textContent = `Failed: ${/** @type {Error} */ (error).message}`;
    } finally {
      topUpButton.disabled = false;
    }
  });
  const retireInput = /** @type {HTMLInputElement} */ (container.querySelector('#retire-confirm'));
  const retireButton = /** @type {HTMLButtonElement} */ (container.querySelector('#retire-send'));
  const retireStatus = /** @type {HTMLElement} */ (container.querySelector('#retire-status'));
  retireInput.addEventListener('input', () => {
    retireButton.disabled = suspended || retireInput.value !== listing.slug;
  });
  retireButton.addEventListener('click', async () => {
    retireButton.disabled = true;
    retireStatus.hidden = false;
    retireStatus.textContent = 'Sending…';
    try {
      await deps.ensureArc();
      const walletClient = deps.walletClientFor();
      const { hash } = await retireService({ walletClient, registryAddress: deps.registryAddress, serviceId: listing.serviceId });
      retireStatus.textContent = `Sent: ${hash}`;
    } catch (error) {
      retireStatus.textContent = `Failed: ${/** @type {Error} */ (error).message}`;
      retireButton.disabled = retireInput.value !== listing.slug;
    }
  });
}

/**
 * "1.5" -> 1500000000000000000n (18-decimal native units). `null` for
 * anything that is not a plain non-negative decimal.
 * @param {string} input
 * @returns {bigint | null}
 */
function parseUsdcToNativeUnits(input) {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const paddedFraction = fraction.padEnd(18, '0').slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(paddedFraction || '0');
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export const __parseUsdcToNativeUnitsForTests = parseUsdcToNativeUnits;
