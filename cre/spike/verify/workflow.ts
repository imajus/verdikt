// Spike B — the per-request confidential workflow, reduced to the four things
// docs/Tasks.md §0.3 needs answered (HTTP trigger, outbound HTTP from inside
// the enclave, an Arc EVM write, and confidential mode). It is deliberately
// NOT the real workflow: no ENS read, no X-PAYMENT decode, no SLA parsing.
// Those wait on Spikes A and C and on Phase 1.
//
// What it does prove, and what it is here to prove:
//
//   1. `@verdikt/sla` and `@verdikt/sdk` — plain ESM JS with ambient .d.ts —
//      import and bundle into the CRE WASM binary. That is the whole language
//      argument: pick TS and the evaluation engine is shared; pick Go and it
//      is written twice and the copies drift.
//   2. Arc Testnet is a first-class EVM write target, so verdicts need no
//      relay path.
//   3. The evaluation runs inside the enclave over the provider's real
//      response body; only the outcome ordinal crosses back out.

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

import { outcomeToOrdinal } from '@verdikt/sdk/registry';

import { evaluateSpike } from './evaluate';

export type Config = {
  /**
   * Empty in simulation. Deployed, this is the proxy's signing key: the
   * gateway rejects any trigger request not signed by a key listed here
   * (spike finding CRE-4), which is what stops a third party from
   * manufacturing verdicts by calling the workflow directly.
   *
   * Not a bare address — the capability takes `{ type, publicKey }` pairs,
   * with `KEY_TYPE_ECDSA_EVM` the only key type currently defined.
   */
  authorizedKeys: { type: 'KEY_TYPE_ECDSA_EVM'; publicKey: string }[];
  /** `arc-testnet`. Resolved through getNetwork() rather than hardcoding the selector. */
  arcChainSelectorName: string;
  /** VerdiktRegistry on Arc — the report receiver. Placeholder until Phase 2 deploys it. */
  registryAddress: string;
  gasLimit: string;
};

/**
 * What the proxy sends. The real trigger payload will carry the `X-PAYMENT`
 * header for the enclave to replay (Specification.md §2); the spike passes an
 * opaque `paymentHeader` string through unexamined, because what is inside it
 * is Spike C's question, not this one.
 */
type VerifyRequest = {
  serviceId: Hex;
  requestId: Hex;
  providerUrl: string;
  paymentHeader?: string;
  payer: Address;
  paidAmountMinorUnits: string;
  latencyBudgetMs: number;
};

/** ABI shape of the verdict report. Mirrors IVerdiktRegistry.setVerdict's arguments. */
const VERDICT_REPORT_PARAMS = parseAbiParameters(
  'bytes32 serviceId, bytes32 requestId, uint8 outcome, address payer, uint256 paidAmount'
);

const decodeTriggerInput = (input: Uint8Array): VerifyRequest =>
  decodeJson(input) as VerifyRequest;

/**
 * Runs inside the enclave. `TeeRuntime`, not `Runtime` — that type difference
 * is the whole enclave boundary.
 *
 * Note what is absent: no `runtime.log` of the response body. Log output
 * leaves the enclave, so logging the payload would undo the confidentiality
 * this handler exists to provide.
 */
export const onVerifyRequest = (
  runtime: TeeRuntime<Config>,
  trigger: HTTPPayload
): string => {
  const config = runtime.config;
  const request = decodeTriggerInput(trigger.input);

  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName: config.arcChainSelectorName
  });
  if (!network) {
    throw new Error(`unknown chain selector name: ${config.arcChainSelectorName}`);
  }

  // Passing the TeeRuntime to the ordinary HTTPClient is what makes the call
  // execute from inside the enclave. ConfidentialHTTPClient is a different
  // capability and has no TeeRuntime overload — using it here would not compile.
  //
  // A transport failure throws rather than returning a status, and that throw
  // is the only source of DOWN: "payment settled and nothing
  // usable came back" (Specification.md §1). Swallowing it would turn a dead
  // provider into a silent no-verdict and cost the agent its refund, so it is
  // caught here and turned into `status: null`, not left to propagate.
  const started = runtime.now().getTime();
  let status: number | null = null;
  let body = '';
  try {
    const response = new HTTPClient()
      .sendRequest(runtime, {
        url: request.providerUrl,
        method: 'GET',
        ...(request.paymentHeader
          ? { multiHeaders: { 'X-PAYMENT': { values: [request.paymentHeader] } } }
          : {})
      })
      .result();
    status = Number(response.statusCode);
    body = text(response);
  } catch {
    // Deliberately not logged: an error message can echo the request, and log
    // output leaves the enclave.
    status = null;
  }
  const latencyMs = runtime.now().getTime() - started;

  // Latency is measured here and handed to the engine as an input. The engine
  // itself never reads a clock — that is what keeps a final, undisputable
  // verdict reproducible (Tasks.md §1.3).
  const outcome = evaluateSpike({
    status,
    body,
    latencyMs,
    latencyBudgetMs: request.latencyBudgetMs
  });

  // Cross back to the DON. Only the outcome ordinal and the payment facts go
  // over — never the response body, never the payment header.
  const donRuntime = runtime.usingTheDons();

  const encodedVerdict = encodeAbiParameters(VERDICT_REPORT_PARAMS, [
    request.serviceId,
    request.requestId,
    outcomeToOrdinal(outcome),
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
    throw new Error(`verdict write failed: ${txResult.errorMessage || txResult.txStatus}`);
  }

  // Whether this return value reaches the proxy is the spike's one open
  // question (finding CRE-3): Chainlink's own docs say both that the gateway
  // answers ACCEPTED immediately and that the callback's return value is sent
  // back as the HTTP response. Specification.md §2's request path needs the
  // latter. Until a logged-in simulate settles it, treat this as
  // `cre workflow simulate` output only.
  return `${outcome} ${bytesToHex(txResult.txHash ?? new Uint8Array(32))}`;
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
