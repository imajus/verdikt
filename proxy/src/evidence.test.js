import { describe, expect, it, vi } from 'vitest';
import { addressOf, signPersonalMessage } from '@verdikt/sdk';
import {
  EVIDENCE_AUTH_HEADER,
  authorizeDisclosure,
  buildEnvelope,
  createMemoryEvidenceStore,
  disclosureMessage
} from './evidence.js';

const REQUEST_ID = `0x${'ab'.repeat(32)}`;
const OTHER_ID = `0x${'cd'.repeat(32)}`;
const PAYER_KEY = `0x${'11'.repeat(32)}`;
const STRANGER_KEY = `0x${'22'.repeat(32)}`;
const PAYER = addressOf(PAYER_KEY);

/** @param {Partial<StoredVerdict>} [overrides] */
const verdictFor = (overrides = {}) => ({
  serviceId: `0x${'00'.repeat(32)}`,
  requestId: REQUEST_ID,
  outcome: /** @type {SlaOutcome} */ ('PASS'),
  payer: PAYER,
  paidAmount: 2500n,
  failedClause: `0x${'00'.repeat(32)}`,
  blockNumber: 1n,
  refundCredited: 0n,
  writtenAt: 1789000000,
  ...overrides
});

const registryWith = (/** @type {StoredVerdict|null} */ verdict) => ({
  getVerdict: vi.fn(async () => verdict)
});

/** @param {Partial<VerificationResult>} [overrides] @returns {VerificationResult} */
const result = (overrides = {}) => ({
  outcome: 'PASS',
  mode: 'sla',
  reason: null,
  clauses: [],
  tx: null,
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"summary":"..."}',
  ...overrides
});

describe('the envelope', () => {
  it('carries the request alongside the response, because a body alone is not evidence', () => {
    const envelope = buildEnvelope({
      requestId: REQUEST_ID,
      slug: 'summarizer',
      method: 'POST',
      url: 'https://provider.example/summarize',
      requestBody: new TextEncoder().encode('{"document":"hello"}').buffer,
      result: result(),
      now: 1789000000
    });
    expect(envelope.request).toEqual({
      method: 'POST',
      url: 'https://provider.example/summarize',
      body: '{"document":"hello"}'
    });
    expect(envelope.response.body).toBe('{"summary":"..."}');
    expect(envelope.response.contentType).toBe('application/json');
    expect(envelope.cachedAt).toBe(1789000000);
  });

  it('records a GET as having no body rather than an empty one', () => {
    const envelope = buildEnvelope({
      requestId: REQUEST_ID,
      slug: 'weather',
      method: 'GET',
      url: 'https://provider.example/current',
      requestBody: undefined,
      result: result()
    });
    expect(envelope.request.body).toBeNull();
  });

  // A judge deciding on a clipped body is deciding on evidence it was not told
  // was clipped, and a semantic clause can turn on exactly the part that went
  // missing. The flag travels rather than being dropped (#88).
  it('keeps the truncation flag', () => {
    const envelope = buildEnvelope({
      requestId: REQUEST_ID,
      slug: 'weather',
      method: 'GET',
      url: 'https://provider.example/current',
      requestBody: undefined,
      result: result({ bodyTruncated: true })
    });
    expect(envelope.response.bodyTruncated).toBe(true);
  });
});

describe('the disclosure gate', () => {
  const sign = (/** @type {string} */ requestId, key = PAYER_KEY) =>
    signPersonalMessage(key, disclosureMessage(requestId));

  it('lets the payer through', async () => {
    const gate = await authorizeDisclosure({
      requestId: REQUEST_ID,
      signature: await sign(REQUEST_ID),
      registry: registryWith(verdictFor())
    });
    expect(gate).toEqual({ ok: true, payer: PAYER });
  });

  it('refuses an unsigned request, and says what to sign', async () => {
    const gate = await authorizeDisclosure({
      requestId: REQUEST_ID,
      signature: null,
      registry: registryWith(verdictFor())
    });
    expect(gate).toMatchObject({ ok: false, status: 401, error: 'disclosure_unauthorized' });
    expect(/** @type {{ detail: string }} */ (gate).detail).toContain(EVIDENCE_AUTH_HEADER);
  });

  it('refuses anyone who is not the payer', async () => {
    const gate = await authorizeDisclosure({
      requestId: REQUEST_ID,
      signature: await sign(REQUEST_ID, STRANGER_KEY),
      registry: registryWith(verdictFor())
    });
    expect(gate).toMatchObject({ ok: false, status: 403 });
  });

  // The message names the request, so a signature the payer made to open one
  // call's evidence cannot open another's.
  it('refuses a signature made for a different request', async () => {
    const gate = await authorizeDisclosure({
      requestId: REQUEST_ID,
      signature: await sign(OTHER_ID),
      registry: registryWith(verdictFor())
    });
    expect(gate).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses when Arc recorded no verdict at all', async () => {
    const gate = await authorizeDisclosure({
      requestId: REQUEST_ID,
      signature: await sign(REQUEST_ID),
      registry: registryWith(null)
    });
    expect(gate).toMatchObject({ ok: false, status: 404, error: 'no_verdict' });
  });

  // Distinct from "not authorised": the judge reads 5xx as transient and
  // retries, and reads 403 as the claimant's own mistake.
  it('reports an Arc outage as unavailable rather than as a refusal', async () => {
    const gate = await authorizeDisclosure({
      requestId: REQUEST_ID,
      signature: await sign(REQUEST_ID),
      registry: {
        getVerdict: vi.fn(async () => {
          throw new Error('rpc down');
        })
      }
    });
    expect(gate).toMatchObject({ ok: false, status: 503, error: 'registry_unavailable' });
  });

  it('refuses malformed signature bytes without throwing', async () => {
    const gate = await authorizeDisclosure({
      requestId: REQUEST_ID,
      signature: '0xnot-a-signature',
      registry: registryWith(verdictFor())
    });
    expect(gate).toMatchObject({ ok: false, status: 403 });
  });
});

describe('the store', () => {
  const envelope = () =>
    buildEnvelope({
      requestId: REQUEST_ID,
      slug: 'weather',
      method: 'GET',
      url: 'https://provider.example/current',
      requestBody: undefined,
      result: result()
    });

  it('returns what was stored', async () => {
    const store = createMemoryEvidenceStore();
    await store.store(REQUEST_ID, envelope(), 1000);
    expect(await store.read(REQUEST_ID, 1000)).toMatchObject({ requestId: REQUEST_ID });
  });

  it('returns null for a request it never saw', async () => {
    const store = createMemoryEvidenceStore();
    expect(await store.read(REQUEST_ID, 1000)).toBeNull();
  });

  it('drops an entry once the filing window has lapsed', async () => {
    let now = 0;
    const store = createMemoryEvidenceStore({ now: () => now });
    await store.store(REQUEST_ID, envelope(), 1000);
    now = 1001;
    expect(await store.read(REQUEST_ID, 1000)).toBeNull();
  });

  // The two clocks. Several validators re-read the same envelope, so the
  // window that matters after the first read is the adjudication runway, not
  // whatever was left of the filing window.
  it('restarts the clock on the adjudication window at the first read', async () => {
    let now = 0;
    const store = createMemoryEvidenceStore({ now: () => now });
    await store.store(REQUEST_ID, envelope(), 1000);

    now = 900;
    expect(await store.read(REQUEST_ID, 5000)).not.toBeNull();

    // Past the original expiry, well inside the extended one.
    now = 1500;
    expect(await store.read(REQUEST_ID, 5000)).not.toBeNull();
  });

  it('does not extend a second time, so the runway is bounded', async () => {
    let now = 0;
    const store = createMemoryEvidenceStore({ now: () => now });
    await store.store(REQUEST_ID, envelope(), 1000);

    now = 100;
    await store.read(REQUEST_ID, 1000); // expires at 1100
    now = 1000;
    await store.read(REQUEST_ID, 1000); // must not push it to 2000
    now = 1101;
    expect(await store.read(REQUEST_ID, 1000)).toBeNull();
  });
});
