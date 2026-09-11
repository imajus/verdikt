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
import { encodeAbiParameters, keccak256, parseAbiParameters, toHex, type Address, type Hex } from 'viem';

import { failedClauseOf, judge, observationFrom, shouldWriteVerdict } from '@verdikt/cre/judge';
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
  /**
   * Which header name `paymentHeader` actually arrived as (`payment-signature`
   * in x402 v2, `x-payment` in v1). This replay sends it back to the provider
   * under the same name — a v2 provider does not recognize the other one, so
   * hardcoding either name here would make the enclave's own call fail exactly
   * the way the proxy's detection used to.
   */
  paymentHeaderName: string;
  payer: Address;
  paidAmountMinorUnits: string;
  /** The `sla` ENS text record, verbatim, or null if it could not be read. */
  sla: string | null;
  /**
   * Where to push the result. The trigger response does not carry a handler's
   * return value and no endpoint for reading an execution's result is
   * documented (CRE-3, CRE-9), so the proxy — which is still holding the
   * agent's connection — gets it pushed back here, correlated by requestId.
   */
  callbackUrl?: string;
};

/** Mirrors `VerdiktRegistry.onReport`'s decode. The two must change together. */
const VERDICT_REPORT_PARAMS = parseAbiParameters(
  'bytes32 serviceId, bytes32 requestId, uint8 outcome, address payer, uint256 paidAmount, bytes32 failedClause'
);

/**
 * The failing clause travels as `keccak256(id)`, never the string.
 *
 * The id is provider-authored and unbounded, and this is written once per paid
 * call. A reader already holds the SLA from ENS, so it hashes the declared ids
 * and matches. Nothing that is not a clause id — a status-only DOWN, the
 * implicit `delivery` clause — hashes to anything the SLA declares, which is
 * why the zero word is reserved for "no clause named".
 */
const clauseHash = (id: string | null): Hex =>
  id === null ? '0x0000000000000000000000000000000000000000000000000000000000000000' : keccak256(toHex(id));

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
  // Callback authentication is a credential, not workflow configuration. Read
  // it inside the TEE so it is available in simulation from .env and, when
  // deployed, only from the Vault DON.
  const callbackToken = request.callbackUrl ? runtime.getSecret({ id: 'CALLBACK_TOKEN' }).result().value : undefined;

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
        // Replayed under whichever header name the agent actually sent
        // (`payment-signature` in x402 v2, `x-payment` in v1) — a v2
        // provider like Alchemy does not recognize the other name at all.
        multiHeaders: { [request.paymentHeaderName]: { values: [request.paymentHeader] } }
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

  // The payload has to travel back through this return value.
  //
  // The trigger response does not carry it (Spike B, CRE-3), and the proxy
  // cannot fetch it itself — an x402 payment settles once, so the call made
  // above IS the call, and its response is the only copy of what the agent
  // bought. Two consequences worth stating rather than discovering:
  //
  //   - the body crosses the DON boundary, so it is no longer only ever inside
  //     the enclave. What attestation still buys is that the code *judging* it
  //     is fixed and published — which is §2's actual claim — but a provider
  //     should be told this plainly rather than left to assume otherwise;
  //   - the DON consensus observation is capped (25kb in simulation). A larger
  //     response cannot come back whole, so it is truncated and flagged rather
  //     than silently cut: the agent paid for it and has to be able to tell.
  const MAX_BODY_BYTES = 20_000;
  const fullBody = bodyText ?? '';
  const body = fullBody.length > MAX_BODY_BYTES ? fullBody.slice(0, MAX_BODY_BYTES) : fullBody;
  const relay = { status, body, bodyTruncated: body.length !== fullBody.length };

  // A 4xx under the status-only fallback writes nothing at all. `onReport` has
  // no way to express that — every report it accepts writes a verdict — so the
  // skip has to happen before a report is built. The payload still comes back:
  // no verdict is not the same as no delivery.
  if (!shouldWriteVerdict(judgement)) {
    return finish(runtime, request, callbackToken, {
      ...relay,
      outcome: null,
      mode: judgement.mode,
      reason: judgement.fallbackReason,
      clauses: judgement.clauses,
      tx: null
    });
  }

  // Cross back to the DON to have the verdict signed into a report. The payment
  // header never crosses — only the payer address and the amount, which are what
  // the registrar needs and nothing more.
  const donRuntime = runtime.usingTheDons();

  const encodedVerdict = encodeAbiParameters(VERDICT_REPORT_PARAMS, [
    request.serviceId,
    request.requestId,
    outcomeToOrdinal(judgement.outcome as SlaOutcome),
    request.payer,
    BigInt(request.paidAmountMinorUnits),
    clauseHash(failedClauseOf(judgement))
  ]);

  const signedReport = donRuntime.report(prepareReportRequest(encodedVerdict)).result();

  const txResult = new EVMClient(network.chainSelector.selector)
    .writeReport(donRuntime, {
      receiver: config.registryAddress,
      report: signedReport,
      gasConfig: { gasLimit: config.gasLimit }
    })
    .result();

  // A failed Arc write must NOT throw. The agent has paid and the enclave holds
  // the only copy of what it bought, so throwing here would destroy the payload
  // to report a bookkeeping failure. The proxy relays the response and surfaces
  // the miss (Tasks.md 4.4); the verdict can be rewritten, the response cannot.
  const wrote = txResult.txStatus === TxStatus.SUCCESS;

  return finish(runtime, request, callbackToken, {
    ...relay,
    outcome: judgement.outcome,
    mode: judgement.mode,
    reason: judgement.fallbackReason,
    clauses: judgement.clauses,
    tx: wrote ? bytesToHex(txResult.txHash ?? new Uint8Array(32)) : null,
    writeError: wrote ? null : txResult.errorMessage || String(txResult.txStatus)
  });
};

/**
 * Hand the finished verification back to the proxy, then return it.
 *
 * Pushed rather than polled because there is nothing to poll: Chainlink
 * documents no endpoint for reading an execution's result (CRE-9). The return
 * value is kept as well, because that is what `cre workflow simulate` prints —
 * so a simulate run stays readable even with no proxy listening.
 *
 * A failed push is NOT fatal. The verdict is already on Arc by this point, and
 * throwing would lose the response body the agent paid for to report a delivery
 * problem the proxy will notice anyway when it times out.
 */
const finish = (
  runtime: TeeRuntime<Config>,
  request: VerifyRequest,
  callbackToken: string | undefined,
  result: Record<string, unknown>
): string => {
  const payload = JSON.stringify({ requestId: request.requestId, ...result });
  if (request.callbackUrl) {
    try {
      new HTTPClient()
        .sendRequest(runtime, {
          url: request.callbackUrl,
          method: 'POST',
          body: new TextEncoder().encode(payload),
          multiHeaders: {
            'Content-Type': { values: ['application/json'] },
            ...(callbackToken
              ? { Authorization: { values: [`Bearer ${callbackToken}`] } }
              : {})
          }
        })
        .result();
    } catch {
      // Deliberately not logged: the payload is in scope here and log output
      // leaves the enclave.
    }
  }
  return payload;
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
