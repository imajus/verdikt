// @verdikt/sdk/registry — the JS side of the Arc registry ABI.
//
// The enum mappings below are implemented rather than stubbed: they ARE the
// seam. Getting an ordinal wrong would silently reclassify a FAIL as a PASS.

/**
 * Mirrors `IVerdiktRegistry.Outcome`. Changing either side without the other
 * is a correctness bug, not a refactor.
 * @type {Readonly<Record<SlaOutcome, number>>}
 */
export const OUTCOME_ORDINAL = Object.freeze({
  PASS: 0,
  FAIL: 1,
  DOWN: 2
});

/**
 * Mirrors `IVerdiktRegistry.Status`.
 * @type {Readonly<Record<ServiceStatus, number>>}
 */
export const STATUS_ORDINAL = Object.freeze({
  NONE: 0,
  ACTIVE: 1,
  SUSPENDED: 2,
  DEREGISTERED: 3
});

/** @type {SlaOutcome[]} */
const OUTCOME_BY_ORDINAL = ['PASS', 'FAIL', 'DOWN'];

/** @type {ServiceStatus[]} */
const STATUS_BY_ORDINAL = ['NONE', 'ACTIVE', 'SUSPENDED', 'DEREGISTERED'];

/**
 * @param {SlaOutcome} outcome
 * @returns {number}
 */
export function outcomeToOrdinal(outcome) {
  if (!Object.hasOwn(OUTCOME_ORDINAL, outcome)) throw new Error(`unknown outcome: ${outcome}`);
  return OUTCOME_ORDINAL[outcome];
}

/**
 * @param {number} ordinal
 * @returns {SlaOutcome}
 */
export function outcomeFromOrdinal(ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= OUTCOME_BY_ORDINAL.length) {
    throw new Error(`unknown outcome ordinal: ${ordinal}`);
  }
  return OUTCOME_BY_ORDINAL[ordinal];
}

/**
 * @param {number} ordinal
 * @returns {ServiceStatus}
 */
export function statusFromOrdinal(ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= STATUS_BY_ORDINAL.length) {
    throw new Error(`unknown status ordinal: ${ordinal}`);
  }
  return STATUS_BY_ORDINAL[ordinal];
}

/**
 * Decimals of the USDC ERC-20 an x402 payment is denominated in. Read back
 * from `decimals()` on Arc Testnet's USDC (0x3600…0000) during Spike C.
 */
export const PAYMENT_ASSET_DECIMALS = 6;

/**
 * Decimals of Arc's *native* USDC — the unit `msg.value` is counted in, and
 * therefore the unit deposits, refunds and `owed` balances are counted in.
 */
export const ARC_NATIVE_DECIMALS = 18;

/**
 * Convert a decoded `paidAmount` into the units the Arc registry works in.
 *
 * This exists because the two ends of a refund are denominated differently
 * and nothing about the types says so. An x402 payment moves the USDC ERC-20,
 * whose `decimals()` is 6; the bond is held and refunded as Arc's native USDC,
 * which has 18. Handing `decodePayment`'s `amount` straight to `setVerdict`
 * would put 2500 wei up against a deposit denominated in 10^18, so
 * `min(FIXED_REFUND, paidAmount, deposit)` would always pick `paidAmount` and
 * every refund would be a trillionth of what was paid — a silently wrong
 * refund, on a verdict with no dispute layer to catch it
 * (Specification.md §3).
 *
 * @param {bigint} amount integer in the asset's minor units
 * @param {number} [assetDecimals] defaults to USDC's 6
 * @returns {bigint} integer in Arc native units (wei)
 */
export function toArcNativeUnits(amount, assetDecimals = PAYMENT_ASSET_DECIMALS) {
  if (typeof amount !== 'bigint' || amount < 0n) {
    throw new Error('toArcNativeUnits: amount must be a non-negative bigint');
  }
  if (!Number.isInteger(assetDecimals) || assetDecimals < 0 || assetDecimals > ARC_NATIVE_DECIMALS) {
    // Scaling down would truncate, and a refund that silently rounds is worse
    // than one that refuses to compute.
    throw new Error(`toArcNativeUnits: unsupported asset decimals: ${assetDecimals}`);
  }
  return amount * 10n ** BigInt(ARC_NATIVE_DECIMALS - assetDecimals);
}

/**
 * Derive a serviceId from a slug: `keccak256(utf8Bytes(slug))`.
 *
 * The slug is one identifier reused across three surfaces — the Arc
 * serviceId, the `<slug>.verdikt.bond` route and the `<slug>.verdikt.eth`
 * subname (Specification.md §3) — so this derivation must agree exactly with
 * `IVerdiktRegistry.serviceIdOf`. Phase 2 should assert that against the
 * deployed contract rather than trusting both to be right.
 *
 * @param {string} slug
 * @returns {string} 0x-prefixed 32-byte hex
 */
export function serviceIdOf(slug) {
  throw new Error('NOT_IMPLEMENTED: serviceIdOf() — Tasks.md Phase 2');
}
