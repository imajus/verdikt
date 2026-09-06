import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  parseAbiParameters,
  toHex
} from 'viem';
import {
  DEFAULT_PARENT_NAME,
  ENS_BACKEND,
  clearServiceRecordCache,
  dnsEncode,
  resolveServiceRecord,
  resolverRecordsAbi,
  serviceName,
  writeServiceScores
} from './ens.js';

const RPC = 'http://ens.test/rpc';
const RESOLVER = '0x00000000000000000000000000000000000000aa';

/**
 * Stands in for the Sepolia RPC. Decodes the `resolve(name, data)` the SDK
 * sends, looks the inner call up in `records`, and answers with the ABI the
 * real Universal Resolver would return — so this exercises the encode/decode
 * path rather than asserting the SDK against itself.
 *
 * @param {{ addr?: string, sla?: string, conformance?: string, availability?: string }} records
 *        Omit a key to make it unset; `revert` makes the whole name unresolvable.
 */
function mockRpc(records) {
  /** @param {`0x${string}`} data */
  const answer = (data) => {
    const outer = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'resolve',
          stateMutability: 'view',
          inputs: [
            { name: 'name', type: 'bytes' },
            { name: 'data', type: 'bytes' }
          ],
          outputs: [
            { name: '', type: 'bytes' },
            { name: '', type: 'address' }
          ]
        }
      ],
      data
    });
    const inner = decodeFunctionData({ abi: resolverRecordsAbi, data: /** @type {`0x${string}`} */ (outer.args[1]) });

    /** @type {`0x${string}`} */
    let result = '0x';
    if (inner.functionName === 'addr' && records.addr !== undefined) {
      result = encodeFunctionResult({
        abi: resolverRecordsAbi,
        functionName: 'addr',
        result: /** @type {`0x${string}`} */ (records.addr)
      });
    }
    if (inner.functionName === 'text') {
      const key = /** @type {'sla'|'conformance'|'availability'} */ (inner.args?.[1]);
      if (records[key] !== undefined) {
        result = encodeFunctionResult({
          abi: resolverRecordsAbi,
          functionName: 'text',
          result: /** @type {string} */ (records[key])
        });
      }
    }
    return encodeAbiParameters(parseAbiParameters('bytes, address'), [result, RESOLVER]);
  };

  return vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const one = (/** @type {{ id: number, params: [{ data: `0x${string}` }] }} */ request) => ({
      jsonrpc: '2.0',
      id: request.id,
      result: answer(request.params[0].data)
    });
    const payload = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => {
  clearServiceRecordCache();
  vi.unstubAllGlobals();
});

describe('name derivation', () => {
  it('maps one slug to the subname and the route without a lookup table', () => {
    expect(serviceName('weather')).toBe(`weather.${DEFAULT_PARENT_NAME}`);
    expect(serviceName('weather', 'example.eth')).toBe('weather.example.eth');
  });

  it('DNS-encodes a name in wire format', () => {
    expect(dnsEncode('a.eth')).toBe(toHex(new Uint8Array([1, 97, 3, 101, 116, 104, 0])));
  });
});

describe('resolveServiceRecord', () => {
  it('returns all four records from one round trip', async () => {
    const fetchMock = mockRpc({
      addr: '0x1111111111111111111111111111111111111111',
      sla: '{"version":1,"clauses":[]}',
      conformance: '987',
      availability: '1000'
    });
    vi.stubGlobal('fetch', fetchMock);

    const record = await resolveServiceRecord('weather', { rpcUrl: RPC });

    expect(record).toMatchObject({
      slug: 'weather',
      name: `weather.${DEFAULT_PARENT_NAME}`,
      serviceId: '0x00840d14970f593887dc91256f2e2f1380aa176569b6c84f16d7f2ced5965666',
      address: '0x1111111111111111111111111111111111111111',
      conformance: 987,
      availability: 1000,
      backend: 'ensv2'
    });
    // The choke point exists so a consumer needing two records makes one call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the sla raw and unparsed', async () => {
    const sla = '{ "version": 1, "clauses": [ { "id": "a" } ] }';
    vi.stubGlobal('fetch', mockRpc({ sla }));
    // Whitespace and all: @verdikt/sla parses, this layer never does.
    expect((await resolveServiceRecord('weather', { rpcUrl: RPC })).sla).toBe(sla);
  });

  it('reports unwritten records as null rather than throwing', async () => {
    vi.stubGlobal('fetch', mockRpc({ sla: '{"version":1}' }));
    const record = await resolveServiceRecord('weather', { rpcUrl: RPC });
    // A service registers on Arc before it publishes anything, and the hourly
    // workflow has not run for a brand-new listing.
    expect(record.address).toBeNull();
    expect(record.conformance).toBeNull();
    expect(record.availability).toBeNull();
    expect(record.sla).not.toBeNull();
  });

  it('reports a zero address record as null', async () => {
    vi.stubGlobal('fetch', mockRpc({ addr: '0x0000000000000000000000000000000000000000' }));
    expect((await resolveServiceRecord('weather', { rpcUrl: RPC })).address).toBeNull();
  });

  it('treats a score that is not a plain 0..1000 integer as unpublished', async () => {
    vi.stubGlobal('fetch', mockRpc({ conformance: '99.5', availability: '1001' }));
    const record = await resolveServiceRecord('weather', { rpcUrl: RPC });
    expect(record.conformance).toBeNull();
    expect(record.availability).toBeNull();
  });

  it('throws when Sepolia is unreachable, so the caller can tell that from an unpublished SLA', async () => {
    // The bug this pins: viem wraps a transport failure in the same error class
    // as a revert, so treating every ContractFunctionExecutionError as "no
    // records" turned an RPC outage into a marketplace where nobody had
    // published anything.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    await expect(resolveServiceRecord('weather', { rpcUrl: RPC })).rejects.toThrow();
  });

  it('reports a name with no resolver as having no records', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init.body));
        // ResolverNotFound() — a custom error revert, which is what the
        // Universal Resolver answers for a subname nobody has onboarded.
        const error = { code: 3, message: 'execution reverted', data: '0x7199966d' };
        const one = (/** @type {{ id: number }} */ request) => ({ jsonrpc: '2.0', id: request.id, error });
        const payload = Array.isArray(body) ? body.map(one) : one(body);
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
      })
    );

    const record = await resolveServiceRecord('weather', { rpcUrl: RPC });
    expect(record).toMatchObject({ slug: 'weather', address: null, sla: null, conformance: null, availability: null });
  });

  it('serves a cached record within its TTL and refetches after it', async () => {
    const fetchMock = mockRpc({ conformance: '500' });
    vi.stubGlobal('fetch', fetchMock);

    await resolveServiceRecord('weather', { rpcUrl: RPC, cacheTtlMs: 60_000 });
    await resolveServiceRecord('weather', { rpcUrl: RPC, cacheTtlMs: 60_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearServiceRecordCache();
    await resolveServiceRecord('weather', { rpcUrl: RPC, cacheTtlMs: 60_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache when no TTL is asked for', async () => {
    const fetchMock = mockRpc({ conformance: '500' });
    vi.stubGlobal('fetch', fetchMock);
    await resolveServiceRecord('weather', { rpcUrl: RPC });
    await resolveServiceRecord('weather', { rpcUrl: RPC });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves the fixture backend without touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const record = await resolveServiceRecord('weather-lite', { backend: ENS_BACKEND.FIXTURE });
    expect(record.slug).toBe('weather-lite');
    expect(record.name).toBe(`weather-lite.${DEFAULT_PARENT_NAME}`);
    expect(record.backend).toBe('fixture');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a slug the registry would refuse', async () => {
    await expect(resolveServiceRecord('Weather', { backend: ENS_BACKEND.FIXTURE })).rejects.toThrow();
  });

  it('says plainly that the v1 fallback was never written', async () => {
    await expect(resolveServiceRecord('weather', { backend: ENS_BACKEND.V1 })).rejects.toThrow(/not implemented/);
  });
});

describe('writeServiceScores', () => {
  const key = `0x${'11'.repeat(32)}`;

  it('refuses a score outside 0..1000 before spending a transaction', async () => {
    for (const scores of [
      { conformance: 1001, availability: 1000 },
      { conformance: -1, availability: 1000 },
      { conformance: 500.5, availability: 1000 },
      { conformance: 500, availability: NaN }
    ]) {
      await expect(writeServiceScores('weather', scores, { privateKey: key, rpcUrl: RPC })).rejects.toThrow(
        /must be an integer 0\.\.1000/
      );
    }
  });
});
