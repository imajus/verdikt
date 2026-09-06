// The per-request confidential workflow (Specification.md §2, Tasks.md 3.1).
//
// This is where a paid call is judged. Everything it does that could take money
// from a provider's bond lives in `@verdikt/cre/judge`, which is plain JS under
// vitest — `cre workflow simulate` cannot run unattended (Spike B, CRE-1), so
// logic that lives only here is logic nothing tests.
//
// What stays here is what genuinely needs the enclave: replaying the agent's
// payment, measuring latency, and crossing back to the DON with nothing but the
// outcome.

import {
  EVMClient,
  HTTPCapability,
  HTTPClient,
  TxStatus,
  bytesToHex,
  decodeJson,
  getNetwork,
  handlerInTee,
  prepareReportRequest,
  text,
  type HTTPPayload,
  type TeeRuntime
} from '@chainlink/cre-sdk';
import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from 'viem';

import { judge, observationFrom, shouldWriteVerdict } from '@verdikt/cre/judge';
import { outcomeToOrdinal } from '@verdikt/sdk/registry';

export type Config = {
  /**
   * The proxy's signing key, as `{ type, publicKey }` pairs. The gateway
   * rejects any trigger request not signed by a key listed here (Spike B,
   * CRE-4), which is what stops a third party manufacturing verdicts by calling
   * the workflow directly. It is the access control the on-chain role cannot
   * provide, since verdicts arrive as DON-signed reports.
   */
  authorizedKeys: { type: 'KEY_TYPE_ECDSA_EVM'; publicKey: string }[];
  /** `arc-testnet`. Resolved through getNetwork() rather than hardcoding a selector. */
  arcChainSelectorName: string;
  /** VerdiktRegistry on Arc — the report receiver. */
  registryAddress: string;
  gasLimit: string;
};

/**
 * What the proxy sends. The `sla` arrives already resolved rather than being
 * read here: `@verdikt/sdk/ens` is the only file that knows ENS exists, and the
 * enclave has no reason to be the exception. It is passed as the raw text
 * record so the engine — not this workflow — decides whether it parses.
 */
type VerifyRequest = {
  serviceId: Hex;
  requestId: Hex;
  providerUrl: string;
  method?: string;
  paymentHeader: string;
  payer: Address;
  paidAmountMinorUnits: string;
  /** The `sla` ENS text record, verbatim, or null if it could not be read. */
  sla: string | null;
};

/** Mirrors `VerdiktRegistry.onReport`'s decode. The two must change together. */
const VERDICT_REPORT_PARAMS = parseAbiParameters(
  'bytes32 serviceId, bytes32 requestId, uint8 outcome, address payer, uint256 paidAmount'
);

/**
 * Runs inside the enclave. `TeeRuntime`, not `Runtime` — that type difference
 * is the whole enclave boundary.
 *
 * Note what is absent: no `runtime.log` of the response body, and no error
 * message echoed from a failed request. Log output leaves the enclave, so
 * either would undo the confidentiality this handler exists to provide.
 */
export const onVerifyRequest = (runtime: TeeRuntime<Config>, trigger: HTTPPayload): string => {
  const config = runtime.config;
  const request = decodeJson(trigger.input) as VerifyRequest;

  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: config.arcChainSelectorName });
  if (!network) throw new Error(`unknown chain selector name: ${config.arcChainSelectorName}`);

  // Passing the TeeRuntime to the ordinary HTTPClient is what makes the call
  // execute from inside the enclave.
  const started = runtime.now().getTime();
  let status: number | null = null;
  let bodyText: string | undefined;
  let transportError: string | undefined;
  try {
    const response = new HTTPClient()
      .sendRequest(runtime, {
        url: request.providerUrl,
        method: request.method ?? 'GET',
        multiHeaders: { 'X-PAYMENT': { values: [request.paymentHeader] } }
      })
      .result();
    status = Number(response.statusCode);
    bodyText = text(response);
  } catch {
    // A transport failure is the only source of DOWN: payment settled and
    // nothing usable came back. Swallowing it would turn a dead provider into a
    // silent no-verdict and cost the agent its refund. The message itself is
    // discarded — it can echo the request, and logs leave the enclave.
    status = null;
    transportError = 'request failed inside the enclave';
  }
  const latencyMs = runtime.now().getTime() - started;

  // Latency is measured here and handed to the engine as an input. The engine
  // never reads a clock, which is what keeps a final, undisputable verdict
  // reproducible (Tasks.md 1.3).
  const judgement = judge(
    request.sla,
    observationFrom({
      status,
      bodyText,
      latencyMs,
      paidAmount: BigInt(request.paidAmountMinorUnits),
      transportError
    })
  );

  // A 4xx under the status-only fallback writes nothing at all. `onReport` has
  // no way to express that — every report it accepts writes a verdict — so the
  // skip has to happen before a report is built.
  if (!shouldWriteVerdict(judgement)) {
    return JSON.stringify({ outcome: null, mode: judgement.mode, reason: judgement.fallbackReason, tx: null });
  }

  // Cross back to the DON. Only the outcome ordinal and the payment facts go
  // over — never the response body, never the payment header.
  const donRuntime = runtime.usingTheDons();

  const encodedVerdict = encodeAbiParameters(VERDICT_REPORT_PARAMS, [
    request.serviceId,
    request.requestId,
    outcomeToOrdinal(judgement.outcome as SlaOutcome),
    request.payer,
    BigInt(request.paidAmountMinorUnits)
  ]);

  const signedReport = donRuntime.report(prepareReportRequest(encodedVerdict)).result();

  const txResult = new EVMClient(network.chainSelector.selector)
    .writeReport(donRuntime, {
      receiver: config.registryAddress,
      report: signedReport,
      gasConfig: { gasLimit: config.gasLimit }
    })
    .result();

  if (txResult.txStatus !== TxStatus.SUCCESS) {
    // The proxy has to relay the payload anyway — the agent paid for it — so
    // this surfaces as a distinct failure rather than swallowing the response
    // (Tasks.md 4.4).
    throw new Error(`verdict write failed: ${txResult.errorMessage || txResult.txStatus}`);
  }

  return JSON.stringify({
    outcome: judgement.outcome,
    mode: judgement.mode,
    reason: judgement.fallbackReason,
    clauses: judgement.clauses,
    tx: bytesToHex(txResult.txHash ?? new Uint8Array(32))
  });
};

export const initWorkflow = (config: Config) => {
  const http = new HTTPCapability();

  return [
    handlerInTee(
      http.trigger({ authorizedKeys: config.authorizedKeys }),
      onVerifyRequest,
      // AWS Nitro in us-west-2 is the only registered TEE type and region.
      [{ tee: 'nitro', regions: ['us-west-2'] }]
    )
  ];
};
