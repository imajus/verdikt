// Ambient types for the CRE workflows. Global by design — no `export` here.

type JudgementMode = 'sla' | 'status-only';

/**
 * The per-request workflow's decision about one paid call.
 *
 * `outcome: null` means **write no verdict at all** — the status-only
 * fallback's 4xx carve-out. `onReport` cannot express that, so the skip has to
 * happen before a report is built; `shouldWriteVerdict` is the guard.
 */
interface Judgement {
  mode: JudgementMode;
  outcome: SlaOutcome | null;
  clauses: SlaClauseResult[];
  /** Why the SLA was not used. `null` when it was. Surfaced for the dashboard, never for a refund. */
  fallbackReason: string | null;
}

interface ServiceScores extends ReputationScores {
  serviceId: string;
  slug: string;
}

interface ScoredService {
  serviceId: string;
  slug: string;
  status: ServiceStatus;
}

interface WindowVerdict {
  serviceId: string;
  outcome: SlaOutcome;
  /** Unix seconds. */
  timestamp: number;
}

interface ReputationInput {
  services: ScoredService[];
  verdicts: WindowVerdict[];
  /** Unix seconds. An argument, never a clock read — the aggregate stays pure. */
  now: number;
  windowSeconds?: number;
}
