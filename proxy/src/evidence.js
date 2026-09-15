// The evidence side of a semantic claim (docs/roadmap/genlayer.md, #82).
//
// A GenLayer validator judging whether a response satisfied a promise needs
// more than the response: it needs to see what was asked for. So what is kept
// is an envelope — request and response together — not a body.
//
// Two things are deliberately absent from this file. It never evaluates
// anything, so `@verdikt/sla` stays out of the proxy. And it holds no policy
// about *who* a claim belongs to: the gate below asks Arc who paid and asks a
// signature whether that payer consents, which is the whole of it.

import { verifyPersonalMessage } from '@verdikt/sdk';

/** The header a caller presents its payer signature in. */
export const EVIDENCE_AUTH_HEADER = 'x-verdikt-evidence-auth';

/**
 * Exactly what a payer signs to unlock its own evidence.
 *
 * Bound to the requestId and to this purpose, so a signature harvested from
 * anywhere else in the system — a refund authorisation, a login — cannot be
 * replayed here, and one issued for one call cannot open another.
 *
 * @param {string} requestId
 */
export const disclosureMessage = (requestId) => `Verdikt evidence disclosure\nrequest: ${requestId.toLowerCase()}`;

/**
 * What the proxy caches, and what the judge is handed verbatim.
 *
 * `request.body` is populated for anything but GET/HEAD. An earlier draft of
 * this design had it unconditionally null, read off a clone 40+ commits behind
 * `origin/main`; #45 had since shipped the request-body replay, and the proxy
 * has had the bytes ever since.
 *
 * @param {{
 *   requestId: string,
 *   slug: string,
 *   method: string,
 *   url: string,
 *   requestBody: ArrayBuffer|undefined,
 *   result: VerificationResult,
 *   now?: number
 * }} args
 * @returns {EvidenceEnvelope}
 */
export function buildEnvelope({ requestId, slug, method, url, requestBody, result, now = Date.now() }) {
  return {
    requestId,
    slug,
    request: {
      method,
      url,
      body: requestBody === undefined ? null : new TextDecoder().decode(requestBody)
    },
    response: {
      status: result.status ?? 0,
      contentType: result.headers?.['content-type'] ?? null,
      body: result.body ?? '',
      bodyEncoding: 'utf8',
      // Carried through rather than hidden: a judge deciding on a clipped body
      // is deciding on evidence it was not told was clipped. See #88 — the cap
      // itself has no explanation that survives reading the code path.
      bodyTruncated: result.bodyTruncated === true
    },
    cachedAt: now
  };
}

/**
 * Whether a caller may read one request's evidence.
 *
 * The gate is the payer's own signature, not the existence of a claim, and the
 * distinction is worth stating because the design doc's earlier round said
 * otherwise. Verifying "a claim is open" would mean the proxy reading GenLayer
 * over a bespoke calldata codec; verifying "the payer consents" reuses the Arc
 * read the proxy already makes and is strictly stronger — it proves the one
 * party entitled to the response asked for it to be disclosed, rather than
 * proving somebody, possibly anybody, filed against it.
 *
 * It also lands on the right side of the existing invariant: the observed value
 * never goes on chain, and reaches the paying agent on its own response,
 * "which is the one party entitled to it". This discloses that agent's own
 * response to adjudicators that agent chose.
 *
 * @param {{ requestId: string, signature: string|null, registry: Pick<RegistryReader, 'getVerdict'> }} args
 * @returns {Promise<{ ok: true, payer: string } | { ok: false, status: number, error: string, detail: string }>}
 */
export async function authorizeDisclosure({ requestId, signature, registry }) {
  if (!signature) {
    return {
      ok: false,
      status: 401,
      error: 'disclosure_unauthorized',
      detail: `evidence is disclosed only to the payer; sign ${JSON.stringify(disclosureMessage(requestId))} and present it in ${EVIDENCE_AUTH_HEADER}`
    };
  }

  /** @type {StoredVerdict|null} */
  let verdict;
  try {
    verdict = await registry.getVerdict(requestId);
  } catch (error) {
    return { ok: false, status: 503, error: 'registry_unavailable', detail: /** @type {Error} */ (error).message };
  }

  // No verdict means no delivered call to disclose evidence about — the same
  // `writtenAt == 0` sentinel the judge's own eligibility gate turns on.
  if (!verdict) {
    return { ok: false, status: 404, error: 'no_verdict', detail: `no verdict was written for ${requestId}` };
  }

  // Malformed signature bytes make viem throw rather than return false, and
  // "the caller sent nonsense" is the same answer as "the caller is not the
  // payer" — neither may read.
  let valid;
  try {
    valid = await verifyPersonalMessage(verdict.payer, disclosureMessage(requestId), signature);
  } catch {
    valid = false;
  }
  if (!valid) {
    return {
      ok: false,
      status: 403,
      error: 'disclosure_unauthorized',
      detail: 'the signature does not recover to the payer this verdict booked'
    };
  }

  return { ok: true, payer: verdict.payer };
}

/**
 * The non-Workers store: a plain Map behind the same shape `evidence-do.js`
 * implements over Durable Objects. Used by tests and by any host that is one
 * long-lived process.
 *
 * @param {{ now?: () => number }} [options]
 * @returns {EvidenceStore}
 */
export function createMemoryEvidenceStore({ now = Date.now } = {}) {
  /** @type {Map<string, { envelope: EvidenceEnvelope, expiresAt: number, disclosed: boolean }>} */
  const entries = new Map();

  const live = (/** @type {string} */ requestId) => {
    const entry = entries.get(requestId);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      entries.delete(requestId);
      return null;
    }
    return entry;
  };

  return {
    async store(requestId, envelope, ttlMs) {
      entries.set(requestId, { envelope, expiresAt: now() + ttlMs, disclosed: false });
    },

    async read(requestId, adjudicationTtlMs) {
      const entry = live(requestId);
      if (!entry) return null;
      // The two clocks. Until a claim is actually adjudicated the entry lives
      // on the filing window; the first authorised read is what starts the
      // adjudication runway, so a claim filed on the last day of the filing
      // window still has time to be judged.
      if (!entry.disclosed) {
        entry.disclosed = true;
        entry.expiresAt = now() + adjudicationTtlMs;
      }
      return entry.envelope;
    }
  };
}
