// Offline evidence for Spike B.
//
// `cre workflow simulate` is the spike's headline deliverable, but it needs a
// logged-in CRE account (finding CRE-1), so it cannot run unattended. These
// tests cover the same ground with the SDK's own capability mocks and run with
// nothing but `bun test` — which is what makes them worth keeping past the
// spike, as the seed of the Phase 3 workflow's test suite.
//
// Run:  bun test        (from cre/spike/verify)

import { expect } from 'bun:test';
import {
  EvmMock,
  HttpActionsMock,
  REPORT_METADATA_HEADER_LENGTH,
  newTestRuntime,
  test
} from '@chainlink/cre-sdk/test';
import type { TeeRuntime } from '@chainlink/cre-sdk';
import { create } from '@bufbuild/protobuf';
import { HTTP_TRIGGER_PB } from '@chainlink/cre-sdk/pb';
import { decodeAbiParameters, parseAbiParameters, type Hex } from 'viem';

import { evaluateSpikeOrSkip } from './evaluate';
import { onVerifyRequest, type Config } from './workflow';

const ARC_TESTNET_SELECTOR = 3034092155422581607n;

const CONFIG: Config = {
  authorizedKeys: [],
  arcChainSelectorName: 'arc-testnet',
  registryAddress: '0x00000000000000000000000000000000000000a1',
  gasLimit: '500000'
};

const SERVICE_ID = `0x${'11'.repeat(32)}` as Hex;
const REQUEST_ID = `0x${'22'.repeat(32)}` as Hex;
const PAYER = '0x000000000000000000000000000000000000beef';

/** The provider payload. Nothing in it may reach the report. */
const SECRET_BODY = JSON.stringify({ temperature_2m: 14.2, secret: 'proprietary-forecast' });

const triggerPayload = (overrides: Record<string, unknown> = {}) =>
  create(HTTP_TRIGGER_PB.PayloadSchema, {
    input: new TextEncoder().encode(
      JSON.stringify({
        serviceId: SERVICE_ID,
        requestId: REQUEST_ID,
        providerUrl: 'https://provider.example/v1/forecast',
        paymentHeader: 'x-payment-blob',
        payer: PAYER,
        paidAmountMinorUnits: '2500',
        latencyBudgetMs: 2000,
        ...overrides
      })
    )
  });

/**
 * The SDK's public test surface exposes `newTestRuntime` (a DON runtime) but no
 * TEE equivalent — `TestTeeRuntime` exists in the package but is not reachable
 * through the `./test` entry point (finding CRE-6). This shim adds the two
 * members `TeeRuntime` has over `Runtime`.
 *
 * It is honest about one thing and dishonest about another. Honest: capability
 * calls made with the TeeRuntime and with `usingTheDons()` are dispatched
 * identically here, which is exactly what the mocks would see. Dishonest: it
 * proves nothing about the enclave boundary itself. Only `cre workflow
 * simulate` and a real deployment do that.
 */
const asTeeRuntime = <C>(runtime: ReturnType<typeof newTestRuntime<C>>): TeeRuntime<C> =>
  new Proxy(runtime, {
    get(target, prop) {
      if (prop === 'usingTheDons') return () => runtime;
      if (prop === 'reportFromDon') return (input: unknown) => (runtime as any).report(input);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }) as unknown as TeeRuntime<C>;

type WrittenVerdict = {
  receiver: string;
  selector: bigint;
  serviceId: Hex;
  requestId: Hex;
  outcome: number;
  payer: string;
  paidAmount: bigint;
  reportBody: Uint8Array;
};

/**
 * Wires the HTTP and EVM mocks, runs the handler, and returns what the Arc
 * write actually carried.
 */
const runHandler = (
  provider: { statusCode: number; body: string } | { throws: string },
  overrides: Record<string, unknown> = {}
): WrittenVerdict => {
  const httpMock = HttpActionsMock.testInstance();
  httpMock.sendRequest = () => {
    if ('throws' in provider) throw new Error(provider.throws);
    return {
      statusCode: provider.statusCode,
      body: Buffer.from(provider.body).toString('base64')
    };
  };

  const evmMock = EvmMock.testInstance(ARC_TESTNET_SELECTOR);
  let written: WrittenVerdict | undefined;

  evmMock.writeReport = (input) => {
    const raw = input.report?.rawReport ?? new Uint8Array();
    const body = raw.slice(REPORT_METADATA_HEADER_LENGTH);
    const [serviceId, requestId, outcome, payer, paidAmount] = decodeAbiParameters(
      parseAbiParameters(
        'bytes32 serviceId, bytes32 requestId, uint8 outcome, address payer, uint256 paidAmount'
      ),
      `0x${Buffer.from(body).toString('hex')}` as Hex
    );
    written = {
      receiver: `0x${Buffer.from(input.receiver).toString('hex')}`,
      selector: ARC_TESTNET_SELECTOR,
      serviceId,
      requestId,
      outcome,
      payer,
      paidAmount,
      reportBody: body
    };
    // WriteReportReplyJson carries txHash as base64, not bytes.
    return {
      txStatus: 'TX_STATUS_SUCCESS',
      txHash: Buffer.from(new Uint8Array(32).fill(7)).toString('base64')
    };
  };

  const runtime = newTestRuntime<Config>(null, {}, CONFIG);
  onVerifyRequest(asTeeRuntime(runtime), triggerPayload(overrides));

  if (!written) throw new Error('handler returned without writing a verdict to Arc');
  return written;
};

// --------------------------------------------------------------- pure engine

test('evaluate: a 4xx writes no verdict at all', () => {
  // The carve-out that stops an agent farming refunds with deliberate garbage
  // (Specification.md §1). `null`, not FAIL.
  expect(evaluateSpikeOrSkip({ status: 404, body: '{}', latencyMs: 10, latencyBudgetMs: 2000 })).toBeNull();
  expect(evaluateSpikeOrSkip({ status: 400, body: '{}', latencyMs: 10, latencyBudgetMs: 2000 })).toBeNull();
});

test('evaluate: outcomes by status and latency', () => {
  const at = (status: number | null, latencyMs: number) =>
    evaluateSpikeOrSkip({ status, body: '{"ok":true}', latencyMs, latencyBudgetMs: 2000 });

  expect(at(200, 10)).toBe('PASS');
  expect(at(503, 10)).toBe('FAIL_CONFORMANCE');
  expect(at(null, 10)).toBe('FAIL_UNREACHABLE');
  // Exactly at the limit passes; one millisecond over does not.
  expect(at(200, 2000)).toBe('PASS');
  expect(at(200, 2001)).toBe('FAIL_CONFORMANCE');
});

// ------------------------------------------------------------- the workflow

test('a conforming response writes a PASS verdict to Arc Testnet', () => {
  const written = runHandler({ statusCode: 200, body: SECRET_BODY });

  // Outcome ordinal 0 = PASS, read through @verdikt/sdk's OUTCOME_ORDINAL —
  // the mapping IVerdiktRegistry.Outcome must agree with.
  expect(written.outcome).toBe(0);
  expect(written.selector).toBe(ARC_TESTNET_SELECTOR);
  expect(written.receiver.toLowerCase()).toBe(CONFIG.registryAddress.toLowerCase());
  expect(written.serviceId).toBe(SERVICE_ID);
  expect(written.requestId).toBe(REQUEST_ID);
  expect(written.payer.toLowerCase()).toBe(PAYER.toLowerCase());
  expect(written.paidAmount).toBe(2500n);
});

test('a 5xx response writes FAIL_CONFORMANCE', () => {
  expect(runHandler({ statusCode: 503, body: 'upstream down' }).outcome).toBe(1);
});

test('a transport failure writes FAIL_UNREACHABLE, not nothing', () => {
  // The agent paid and got nothing. If the handler let the capability error
  // propagate, the run would die before the write and the refund would never
  // be credited — so this asserts a verdict is still written.
  expect(runHandler({ throws: 'connection reset' }).outcome).toBe(2);
});

test('the provider response body never crosses back out of the enclave', () => {
  // The report is everything that leaves. If the payload were in it, the
  // enclave would be decorative — this is the assertion that keeps the
  // confidentiality claim in Specification.md §2 honest.
  const written = runHandler({ statusCode: 200, body: SECRET_BODY });
  const asText = Buffer.from(written.reportBody).toString('utf8');

  expect(asText).not.toContain('proprietary-forecast');
  expect(asText).not.toContain('x-payment-blob');
  // Fixed-width tuple: five 32-byte words, whatever the response body was.
  expect(written.reportBody.length).toBe(5 * 32);
});
