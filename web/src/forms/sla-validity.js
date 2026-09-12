import { parseSla } from '@verdikt/sla';

/**
 * Whether a draft is the SLA the verifier would enforce, in one line. The
 * composer, the service page's editor and the wizard all gate on this so the
 * form and the chain can never disagree about what is publishable.
 * @param {string} source @returns {{ ok: boolean, message: string }}
 */
export function describeSlaValidity(source) {
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, message: 'An SLA needs at least one clause.' };
  try {
    const parsed = parseSla(trimmed);
    return { ok: true, message: `Valid. ${parsed.clauses.length} clause${parsed.clauses.length === 1 ? '' : 's'} plus delivery; the verifier would enforce all of them.` };
  } catch (error) {
    return { ok: false, message: /** @type {Error} */ (error).message };
  }
}
