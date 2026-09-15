// The Durable Object behind the evidence cache, and its client.
//
// `PendingVerification` next door deliberately keeps nothing: an object there
// is meaningful only for the seconds one verification takes. This one is the
// opposite. An envelope has to survive isolate restarts and be re-read by
// several GenLayer validators over hours, so it uses `state.storage` and an
// alarm to expire itself.
//
// One object per requestId, addressed by `idFromName`, for the same reason as
// the other: two HTTP requests to a Worker are not guaranteed to land on the
// same isolate, and the call that writes the evidence is never the call that
// reads it.

const ENVELOPE_KEY = 'envelope';
const EXPIRES_KEY = 'expiresAt';
const DISCLOSED_KEY = 'disclosed';

export class EvidenceCache {
  /** @param {DurableObjectState} state */
  constructor(state) {
    this.state = state;
  }

  /** @param {Request} request */
  async fetch(request) {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const { pathname } = new URL(request.url);
    if (pathname === '/store') {
      const { envelope, ttlMs } = /** @type {{ envelope: EvidenceEnvelope, ttlMs: number }} */ (await request.json());
      return this.#store(envelope, ttlMs);
    }
    if (pathname === '/read') {
      const { adjudicationTtlMs } = /** @type {{ adjudicationTtlMs: number }} */ (await request.json());
      return this.#read(adjudicationTtlMs);
    }
    return new Response('not found', { status: 404 });
  }

  /**
   * @param {EvidenceEnvelope} envelope
   * @param {number} ttlMs
   */
  async #store(envelope, ttlMs) {
    const expiresAt = Date.now() + ttlMs;
    await this.state.storage.put({ [ENVELOPE_KEY]: envelope, [EXPIRES_KEY]: expiresAt, [DISCLOSED_KEY]: false });
    await this.state.storage.setAlarm(expiresAt);
    return Response.json({ stored: true });
  }

  /** @param {number} adjudicationTtlMs */
  async #read(adjudicationTtlMs) {
    const envelope = /** @type {EvidenceEnvelope|undefined} */ (await this.state.storage.get(ENVELOPE_KEY));
    const expiresAt = /** @type {number|undefined} */ (await this.state.storage.get(EXPIRES_KEY));
    // Checked rather than trusted to the alarm: an alarm can fire late, and
    // serving an expired envelope because the cleanup has not run yet would
    // make the window advisory.
    if (!envelope || expiresAt === undefined || expiresAt <= Date.now()) {
      return Response.json({ envelope: null }, { status: 404 });
    }

    // The two clocks (docs/roadmap/genlayer.md). The entry lives on the filing
    // window until it is first disclosed; disclosure is what starts the
    // adjudication runway, so several validators re-reading it keep working
    // even for a claim filed at the very end of the filing window.
    if ((await this.state.storage.get(DISCLOSED_KEY)) !== true) {
      const extended = Date.now() + adjudicationTtlMs;
      await this.state.storage.put({ [DISCLOSED_KEY]: true, [EXPIRES_KEY]: extended });
      await this.state.storage.setAlarm(extended);
    }

    return Response.json({ envelope });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

/**
 * The client side: the same `EvidenceStore` shape `createMemoryEvidenceStore`
 * implements, backed by one Durable Object per requestId. Nothing in the
 * request path knows the difference.
 *
 * @param {DurableObjectNamespace} namespace
 * @returns {EvidenceStore}
 */
export function createDurableObjectEvidenceStore(namespace) {
  const stubFor = (/** @type {string} */ requestId) => namespace.get(namespace.idFromName(requestId));

  return {
    async store(requestId, envelope, ttlMs) {
      await stubFor(requestId).fetch('http://evidence-cache/store', {
        method: 'POST',
        body: JSON.stringify({ envelope, ttlMs })
      });
    },

    async read(requestId, adjudicationTtlMs) {
      const response = await stubFor(requestId).fetch('http://evidence-cache/read', {
        method: 'POST',
        body: JSON.stringify({ adjudicationTtlMs })
      });
      const payload = /** @type {{ envelope: EvidenceEnvelope|null }} */ (await response.json());
      return payload.envelope ?? null;
    }
  };
}
