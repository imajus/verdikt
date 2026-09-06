// @verdikt/sdk — one import surface over two chains.
//
// Arc holds the registry, escrow, verdicts and refunds; Sepolia holds the SLA
// and the marketplace scores on ENS. Callers should not have to know that
// (Specification.md §3), so everything is re-exported from here.

export { ENS_BACKEND, resolveServiceRecord, writeServiceScores } from './ens.js';
export { decodePayment, decodeSettlement, PaymentDecodeError } from './payment.js';
export {
  ARC_NATIVE_DECIMALS,
  PAYMENT_ASSET_DECIMALS,
  toArcNativeUnits,
  OUTCOME_ORDINAL,
  STATUS_ORDINAL,
  outcomeToOrdinal,
  outcomeFromOrdinal,
  statusFromOrdinal,
  serviceIdOf
} from './registry.js';
