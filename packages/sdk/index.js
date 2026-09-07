// @verdikt/sdk — one import surface over two chains.
//
// Arc holds the registry, escrow, verdicts and refunds; Sepolia holds the SLA
// and the marketplace scores on ENS. Callers should not have to know that
// (Specification.md §3), so everything is re-exported from here.

export {
  DEFAULT_PARENT_NAME,
  ENS_BACKEND,
  clearServiceRecordCache,
  resolveServiceRecord,
  serviceName,
  writeServiceScores
} from './ens.js';
export { DEFAULT_ARC_RPC, arcTestnet, createRegistryReader, registryAbi } from './arc.js';
export { ARC, DEPLOYMENTS, SEPOLIA } from './deployments.js';
export { addressOf, signPersonalMessage, verifyPersonalMessage } from './signing.js';
export { decodePayment } from './payment.js';
export {
  OUTCOME_ORDINAL,
  STATUS_ORDINAL,
  outcomeToOrdinal,
  outcomeFromOrdinal,
  statusFromOrdinal,
  serviceIdOf
} from './registry.js';
