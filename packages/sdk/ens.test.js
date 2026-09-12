import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionResult,
  parseAbi,
  parseAbiParameters,
  toHex
} from 'viem';
import {
  DEFAULT_PARENT_NAME,
  ENS_BACKEND,
  clearAddressNameCache,
  clearServiceRecordCache,
  dnsEncode,
  resolveAddressName,
  resolveServiceRecord,
  resolverRecordsAbi,
  serviceName,
  subnameRegistryAbi,
  writeServiceScores
} from './ens.js';
import { SEPOLIA } from './deployments.js';

const RPC = 'http://ens.test/rpc';
const RESOLVER = '0x00000000000000000000000000000000000000aa';

/**
 * Stands in for the Sepolia RPC. Two request shapes are answered: a
 * `resolve(name, data)` against the Universal Resolver (the existing four
 * records), and a `getState(anyId)` against the subname registry directly —
 * `owner` is not a resolver-routed record, it comes straight off the registry.
 *
 * @param {{ addr?: string, sla?: string, conformance?: string, availability?: string, owner?: string }} records
 *        Omit a key to make it unset; `revert` makes the whole name unresolvable.
 */
function mockRpc(records) {
  /** @param {`0x${string}`} data */
  const answerResolve = (data) => {
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

  const answerGetState = () =>
    encodeFunctionResult({
      abi: subnameRegistryAbi,
      functionName: 'getState',
      result: {
        status: records.owner ? 2 : 0,
        expiry: 0n,
        latestOwner: /** @type {`0x${string}`} */ (records.owner ?? '0x0000000000000000000000000000000000000000'),
        tokenId: 0n,
        resource: 0n
      }
    });

  return vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const one = (/** @type {{ id: number, params: [{ to: string, data: `0x${string}` }] }} */ request) => {
      const { to, data } = request.params[0];
      const result =
        to.toLowerCase() === SEPOLIA.ens.subnameRegistry.toLowerCase() ? answerGetState() : answerResolve(data);
      return { jsonrpc: '2.0', id: request.id, result };
    };
    const payload = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => {
  clearServiceRecordCache();
  clearAddressNameCache();
  vi.unstubAllGlobals();
});

// The Universal Resolver's own custom errors (mirrored from viem's internal
// `universalResolverErrors`, which viem does not export publicly) plus the
// `reverseWithGateways` function `getEnsName` calls. `ReverseAddressMismatch`
// is one of the ENS-specific "no name" causes viem's own non-strict mode
// reads as null; `AnUnrelatedError` stands in for the spike's control case —
// a revert that is not one of those causes and must propagate.
const reverseWithGatewaysAbi = parseAbi([
  'error ReverseAddressMismatch(string primary, bytes primaryAddress)',
  'error AnUnrelatedError(uint256 code)',
  'function reverseWithGateways(bytes reverseName, uint256 coinType, string[] gateways) view returns (string, address, address)'
]);

/**
 * Stands in for the Sepolia RPC's answer to `reverseWithGateways` — the call
 * `getEnsName` makes against the Universal Resolver. `name: null` answers
 * with the empty name viem reads as "no primary name set"; `revertError`
 * answers with one of the ABI's own custom-error reverts.
 *
 * @param {{ name?: string|null, revertError?: 'ReverseAddressMismatch'|'AnUnrelatedError' }} outcome
 */
function mockReverseRpc(outcome) {
  return vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const one = (/** @type {{ id: number, params: unknown[] }} */ request) => {
      if (outcome.revertError === 'ReverseAddressMismatch') {
        const data = encodeErrorResult({ abi: reverseWithGatewaysAbi, errorName: 'ReverseAddressMismatch', args: ['name.eth', '0x'] });
        return { jsonrpc: '2.0', id: request.id, error: { code: 3, message: 'execution reverted', data } };
      }
      if (outcome.revertError === 'AnUnrelatedError') {
        const data = encodeErrorResult({ abi: reverseWithGatewaysAbi, errorName: 'AnUnrelatedError', args: [1n] });
        return { jsonrpc: '2.0', id: request.id, error: { code: 3, message: 'execution reverted', data } };
      }
      const result = encodeFunctionResult({
        abi: reverseWithGatewaysAbi,
        functionName: 'reverseWithGateways',
        result: [outcome.name ?? '', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000']
      });
      return { jsonrpc: '2.0', id: request.id, result };
    };
    const payload = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  });
}

describe('resolveAddressName', () => {
  const address = '0x1111111111111111111111111111111111111111';

  it('resolves an address with a primary name set', async () => {
    vi.stubGlobal('fetch', mockReverseRpc({ name: 'alice.eth' }));
    expect(await resolveAddressName(address, { rpcUrl: RPC })).toBe('alice.eth');
  });

  it('reports no primary name as null rather than throwing', async () => {
    vi.stubGlobal('fetch', mockReverseRpc({ name: null }));
    expect(await resolveAddressName(address, { rpcUrl: RPC })).toBeNull();
  });

  it('treats a name that no longer reverse-resolves back to the address as null, the same as no name', async () => {
    // ReverseAddressMismatch() — viem's own non-strict handling of this ENS-
    // specific revert reads it as "no name", not as an error to propagate.
    vi.stubGlobal('fetch', mockReverseRpc({ revertError: 'ReverseAddressMismatch' }));
    expect(await resolveAddressName(address, { rpcUrl: RPC })).toBeNull();
  });

  it('throws on a revert that is not one of ENS reverse resolution\'s own "no name" causes', async () => {
    // The spike's control case: pointed at a contract that is not this
    // Universal Resolver, the call reverted distinctly rather than also
    // reading as "no name" — proof the null cases above are genuine resolver
    // answers, not a masked failure.
    vi.stubGlobal('fetch', mockReverseRpc({ revertError: 'AnUnrelatedError' }));
    await expect(resolveAddressName(address, { rpcUrl: RPC })).rejects.toThrow();
  });

  it('throws when Sepolia is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    await expect(resolveAddressName(address, { rpcUrl: RPC })).rejects.toThrow();
  });

  it('serves a cached name within its TTL and refetches after it', async () => {
    const fetchMock = mockReverseRpc({ name: 'alice.eth' });
    vi.stubGlobal('fetch', fetchMock);

    await resolveAddressName(address, { rpcUrl: RPC, cacheTtlMs: 60_000 });
    await resolveAddressName(address, { rpcUrl: RPC, cacheTtlMs: 60_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearAddressNameCache();
    await resolveAddressName(address, { rpcUrl: RPC, cacheTtlMs: 60_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache when no TTL is asked for', async () => {
    const fetchMock = mockReverseRpc({ name: 'alice.eth' });
    vi.stubGlobal('fetch', fetchMock);
    await resolveAddressName(address, { rpcUrl: RPC });
    await resolveAddressName(address, { rpcUrl: RPC });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
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

  it('returns the subname owner alongside the four records, still in one round trip', async () => {
    const owner = '0x4444444444444444444444444444444444444444';
    const fetchMock = mockRpc({ addr: '0x1111111111111111111111111111111111111111', owner });
    vi.stubGlobal('fetch', fetchMock);
    const record = await resolveServiceRecord('weather', { rpcUrl: RPC });
    expect(record.owner).toBe(owner);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports an unclaimed subname as owner: null, not a zero address', async () => {
    vi.stubGlobal('fetch', mockRpc({}));
    const record = await resolveServiceRecord('weather', { rpcUrl: RPC });
    expect(record.owner).toBeNull();
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
        // Universal Resolver answers for a subname nobody has onboarded. The
        // subname registry itself is a different contract and does not share
        // this error, so its `getState` call still gets a normal answer.
        const one = (/** @type {{ id: number, params: [{ to: string, data: `0x${string}` }] }} */ request) => {
          if (request.params[0].to.toLowerCase() === SEPOLIA.ens.subnameRegistry.toLowerCase()) {
            return {
              jsonrpc: '2.0',
              id: request.id,
              result: encodeFunctionResult({
                abi: subnameRegistryAbi,
                functionName: 'getState',
                result: {
                  status: 0,
                  expiry: 0n,
                  latestOwner: '0x0000000000000000000000000000000000000000',
                  tokenId: 0n,
                  resource: 0n
                }
              })
            };
          }
          const error = { code: 3, message: 'execution reverted', data: '0x7199966d' };
          return { jsonrpc: '2.0', id: request.id, error };
        };
        const payload = Array.isArray(body) ? body.map(one) : one(body);
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
      })
    );

    const record = await resolveServiceRecord('weather', { rpcUrl: RPC });
    expect(record).toMatchObject({
      slug: 'weather',
      address: null,
      sla: null,
      conformance: null,
      availability: null,
      owner: null
    });
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
