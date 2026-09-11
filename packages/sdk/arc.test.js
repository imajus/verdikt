import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, numberToHex, pad } from 'viem';
import { createRegistryReader, registryAbi } from './arc.js';

const RPC = 'http://arc.test/rpc';
const ADDRESS = '0x1111111111111111111111111111111111111111';

/**
 * Answers `eth_getLogs` with an empty result for every call, whether viem
 * sends them one at a time or batched into a single JSON-RPC array — which is
 * exactly the distinction this file's fix turns on: chunk requests issued
 * within the same tick land in one HTTP call instead of one per chunk.
 *
 * @returns {import('vitest').Mock}
 */
function mockRpc() {
  return vi.fn(async (_url, init) => {
    const body = JSON.parse(/** @type {string} */ (init.body));
    /** @param {{id: number}} request */
    const one = (request) => ({ jsonrpc: '2.0', id: request.id, result: [] });
    const payload = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createRegistryReader scan', () => {
  // The whole point of the fix: a fully sequential scan (await one chunk, then
  // the next) never has more than one `eth_getLogs` in flight, so viem's batch
  // transport never has more than one request to coalesce — it would show up
  // here as three separate HTTP calls. Chunks issued within the same
  // concurrency batch land in the same tick, so viem folds them into one.
  it('dispatches chunks within a concurrency batch as one HTTP call, not one per chunk', async () => {
    const fetchMock = mockRpc();
    vi.stubGlobal('fetch', fetchMock);
    const reader = createRegistryReader({ rpcUrl: RPC, address: ADDRESS, deployBlock: 0n, maxBlockRange: 10n });

    // 30 blocks over a 10-block chunk size is 3 chunks; default concurrency is
    // 8, so all 3 fit in the first (and only) batch.
    await reader.listVerdicts({ fromBlock: 0n, toBlock: 29n });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Array.isArray(body) ? body.length : 1).toBe(3);
  });

  it('splits a wider range across as many batches as the concurrency cap requires', async () => {
    const fetchMock = mockRpc();
    vi.stubGlobal('fetch', fetchMock);
    const reader = createRegistryReader({
      rpcUrl: RPC,
      address: ADDRESS,
      deployBlock: 0n,
      maxBlockRange: 10n,
      scanConcurrency: 2
    });

    // 5 chunks (0-9 .. 40-49) at a concurrency of 2 is 3 batches: 2, 2, 1.
    await reader.listVerdicts({ fromBlock: 0n, toBlock: 49n });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    /** @param {any[]} call */
    const sizeOf = (call) => {
      const body = JSON.parse(call[1].body);
      return Array.isArray(body) ? body.length : 1;
    };
    expect(fetchMock.mock.calls.map(sizeOf)).toEqual([2, 2, 1]);
  });

  /**
   * One valid `VerdictWritten` log, encoded so viem can decode it back into args.
   * @param {bigint} blockNumber
   */
  function verdictLog(blockNumber) {
    const serviceId = pad(numberToHex(blockNumber), { size: 32 });
    const requestId = pad(numberToHex(blockNumber + 1n), { size: 32 });
    const topics = encodeEventTopics({ abi: registryAbi, eventName: 'VerdictWritten', args: { serviceId, requestId } });
    const data = encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
      [0, ADDRESS, 0n, pad('0x0', { size: 32 })]
    );
    return {
      address: ADDRESS,
      topics,
      data,
      blockNumber: numberToHex(blockNumber),
      transactionHash: pad('0x1', { size: 32 }),
      transactionIndex: '0x0',
      blockHash: pad('0x2', { size: 32 }),
      logIndex: '0x0',
      removed: false
    };
  }

  it('returns pages in block-ascending order regardless of how the batch itself resolves them', async () => {
    // The response order inside one batched HTTP reply need not match the
    // request order; each chunk's page still has to land back in its own
    // block-ascending slot rather than in reply order.
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const requests = Array.isArray(body) ? body : [body];
      const answers = requests.map((request) => {
        const [{ fromBlock }] = request.params;
        return { jsonrpc: '2.0', id: request.id, result: [verdictLog(BigInt(fromBlock))] };
      });
      // Reverse the reply order to prove the caller doesn't rely on it.
      return new Response(JSON.stringify(answers.reverse()), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const reader = createRegistryReader({ rpcUrl: RPC, address: ADDRESS, deployBlock: 0n, maxBlockRange: 10n });

    const logs = await reader.listVerdicts({ fromBlock: 0n, toBlock: 29n });

    expect(logs.map((log) => log.blockNumber)).toEqual([0n, 10n, 20n]);
  });
});
