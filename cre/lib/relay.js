// Lives here, not in verify/workflow.ts, for the reason http-request.js does:
// that file bundles to WASM and cannot be unit tested, and what it assembles
// here is the only copy of a response an agent has paid for. Dependency-free so
// it can still bundle.

/**
 * The relayed body is clipped at this many characters.
 *
 * Justified in the workflow as the DON consensus observation cap, which does
 * not match the code path — the signed report never carries the body. The cap
 * is real and unexplained; #88 is where that is root-caused.
 */
export const MAX_RELAY_BODY_CHARS = 20_000;

/**
 * What the enclave sends back about the call it made.
 *
 * Two fields here are load-bearing beyond relaying bytes to the agent:
 *
 *   - `content-type` is the only provider header that travels, and a semantic
 *     claim is unjudgeable without it — `SlaClaimJudge` refuses any evidence
 *     envelope whose content type it cannot recognise, so an omitted one makes
 *     every claim resolve UNDETERMINED (#82). The rest of the provider's
 *     headers stay behind on purpose: `content-length` and `content-encoding`
 *     describe bytes that no longer exist once the enclave has decoded and
 *     possibly clipped the body, so relaying them would describe the response
 *     wrongly rather than incompletely.
 *   - `bodyTruncated` is flagged rather than silent. The agent paid for the
 *     response and has to be able to tell it is holding part of one, and a
 *     judge deciding on a clipped body must be told it was clipped.
 *
 * @param {{ status: number|null, contentType?: string|undefined, bodyText?: string|undefined }} response
 * @returns {{ status: number|null, headers: Record<string,string>, body: string, bodyTruncated: boolean }}
 */
export function relayPayload({ status, contentType, bodyText }) {
  const fullBody = bodyText ?? '';
  const body = fullBody.length > MAX_RELAY_BODY_CHARS ? fullBody.slice(0, MAX_RELAY_BODY_CHARS) : fullBody;
  return {
    status: status ?? null,
    headers: contentType ? { 'content-type': contentType } : {},
    body,
    bodyTruncated: body.length !== fullBody.length
  };
}
