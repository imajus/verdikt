// Display formatting for the marketplace.
//
// The one thing to get right here is that Arc exposes the same USDC twice, and
// the dashboard shows values from both views on the same screen:
//
//   - a service's **bond** and a **refund** move as `msg.value`, 18 decimals;
//   - what an agent **paid** comes off the x402 leg, 6 decimals.
//
// They differ by 1e12. Rendering one with the other's scale is a millionfold
// error in a number a consumer is choosing a service on, so the two have
// separate functions and neither takes a decimals argument that could be passed
// wrong.

const NATIVE_DECIMALS = 18n;
const MINOR_DECIMALS = 6n;

/**
 * @param {bigint} value
 * @param {bigint} decimals
 * @param {number} places how many fraction digits to show
 */
function formatUnits(value, decimals, places) {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const scale = 10n ** decimals;
  const whole = magnitude / scale;
  const fraction = magnitude % scale;
  // Truncate rather than round: a bond shown as more than it is would be a
  // consumer-facing overstatement of what backs a refund.
  const digits = fraction.toString().padStart(Number(decimals), '0').slice(0, places);
  const trimmed = digits.replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${trimmed ? `.${trimmed}` : ''}`;
}

/**
 * A bond, a refund, a deposit — anything that moved as `msg.value` on Arc.
 * @param {bigint} value
 * @param {number} [places]
 */
export const formatNativeUsdc = (value, places = 4) => `${formatUnits(value, NATIVE_DECIMALS, places)} USDC`;

/**
 * A refund credited on Arc, which moved in the 18-decimal native view but is
 * capped at what was paid on the 6-decimal x402 leg.
 *
 * Six places, not the default four, and a floor rather than a round-down: a
 * real credit here can be a single USDC minor unit (0.000001), and truncating
 * one of those to `0 USDC` had the ledger reporting no refund on a row where
 * the chain credited one — the opposite of the fact the column exists to
 * carry. Truncation is still the direction of travel for everything larger,
 * so a refund is never shown as more than it was.
 *
 * @param {bigint} value
 */
export const formatRefundUsdc = (value) => {
  const shown = formatNativeUsdc(value, 6);
  return value > 0n && shown === '0 USDC' ? '< 0.000001 USDC' : shown;
};

/**
 * What an agent paid on the x402 leg, and any SLA price bound.
 * @param {bigint} value
 * @param {number} [places]
 */
export const formatMinorUsdc = (value, places = 6) => `${formatUnits(value, MINOR_DECIMALS, places)} USDC`;

/**
 * Two bounds on the same x402 leg, with the asset named once. Naming it twice
 * ("0.001 USDC to 0.01 USDC") reads as two separate amounts rather than one
 * band, and a band is what a price clause declares.
 *
 * @param {bigint} low
 * @param {bigint} high
 * @param {number} [places]
 */
export const formatMinorRange = (low, high, places = 6) =>
  `${formatUnits(low, MINOR_DECIMALS, places)} to ${formatMinorUsdc(high, places)}`;

/**
 * A 0–1000 score as a percentage.
 *
 * `null` is "not published yet", which is not the same as zero — the hourly
 * workflow has simply not run for this listing. Showing 0% would brand a new
 * service as broken, the same mistake the empty-window rule exists to prevent.
 *
 * @param {number|null} score
 */
export const formatScore = (score) => (score === null ? '—' : `${(score / 10).toFixed(1)}%`);

/**
 * The band a score sits in, for colouring. Mirrors the graduated credit banding
 * the availability model is adapted from (Specification.md §1).
 * @param {number|null} score
 * @returns {'unknown'|'good'|'fair'|'poor'}
 */
export const scoreBand = (score) => {
  if (score === null) return 'unknown';
  if (score >= 990) return 'good';
  if (score >= 950) return 'fair';
  return 'poor';
};

/** @param {string} value */
export const shortHex = (value) =>
  typeof value === 'string' && value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : String(value);

const MAX_ERROR_LENGTH = 160;

/**
 * A wallet or RPC failure as one line a provider can act on.
 *
 * viem puts the human sentence on `shortMessage` and a full diagnostic body on
 * `message`: the request arguments, the raw calldata, a docs URL and its own
 * version. That body is written for a console, not a page — it buries the one
 * fact that matters under an unbroken hex blob wide enough to break a layout.
 * Prefer the short form, keep whatever is left to a single capped line, and
 * never invent a reason the error did not give.
 *
 * @param {unknown} error
 */
export const formatTxError = (error) => {
  const source = /** @type {{ shortMessage?: unknown, message?: unknown }} */ (error ?? {});
  const short = typeof source.shortMessage === 'string' ? source.shortMessage : '';
  const full = typeof source.message === 'string' ? source.message : '';
  const line = (short || full).split('\n')[0].trim();
  if (!line) return 'The request failed without a message.';
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH - 1).trimEnd()}…` : line;
};

/** @param {number} unixSeconds */
export const formatWhen = (unixSeconds) => {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return 'unknown';
  // ISO, deliberately: a marketplace comparing services across operators should
  // not render times in whatever locale the browser happens to be in.
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 16);
};
