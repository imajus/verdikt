# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
SlaClaimJudge — GenLayer counterpart to Verdikt's Chainlink CRE workflow.

CRE evaluates deterministic, schema-checkable SLA clauses on every x402 call
(status codes, latency, price) and stays untouched by this contract. This
contract handles `type: "semantic"` clauses (`packages/sla/schema.json`) that
CRE recognizes but deliberately never enforces — deliverables whose
compliance requires judgment rather than a schema match. Second claim-type
handler on the same marketplace, not a replacement.

Two GenLayer web fetches, two different jobs:

- `submit_claim` freezes the disputed clause's `criteria` text from ENS
  (`GET {sla_api_base}/internal/sla/<slug>`, see `docs/roadmap/genlayer.md`)
  via an exact-match nondet fetch, at the moment the claim opens. Frozen, not
  re-fetched at judgment time: a provider editing their SLA mid-dispute must
  not retroactively change what is being judged — the same principle
  `packages/sdk/registry.js`'s `failedClause` hash already protects for
  deterministic clauses ("a non-zero hash matching nothing, meaning the
  provider has edited its SLA since").
- `resolve_claim` fetches the evidence envelope
  (`GET {evidence_api_base}/internal/evidence/<request_id>`), which the proxy
  only serves once `submit_claim` has actually opened a claim for that
  `request_id` (dispute-gated, not cache-gated — see the roadmap doc). An
  incomplete or unsupported envelope resolves to `UNDETERMINED`, never a
  forced `MET`/`BREACH` against either party.

Claims are keyed by `(request_id, clause_id)`, not `request_id` alone — one
verdict can carry several semantic clauses, each independently disputable;
keying on `request_id` alone would silently allow only one semantic claim
per call ever. Evidence stays keyed by `request_id` alone (one envelope per
call, shared across however many of its clauses get disputed).

A fourth outcome, `CANCELLED`, exists alongside `MET`/`BREACH`/
`UNDETERMINED`: if `resolve_claim` never succeeds (relay down, evidence
expired, ENS unreachable, GenLayer consensus never completing),
`cancel_claim` lets anyone close the claim permissionlessly once
`RESOLUTION_TIMEOUT_HOURS` has elapsed since `submit_claim` — an unresolved
claim must not lock the claimant's bond forever with no path back.

**Not yet in this contract, tracked separately (docs/roadmap/genlayer.md,
"Claim eligibility gate"):** nothing here verifies the caller is actually
the payer of the underlying Arc verdict, that a real verdict was even
written (vs. the zero-valued struct Solidity returns for an unset request
id), that a bond was posted, or that the filing deadline hasn't passed.
`submit_claim` as written can be called by anyone against any public
`request_id`.
"""

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from genlayer import *
import genlayer.gl.vm as glvm

OUTCOME_MET = "MET"
OUTCOME_BREACH = "BREACH"
OUTCOME_UNDETERMINED = "UNDETERMINED"
OUTCOME_CANCELLED = "CANCELLED"

# Generous margin past the filing + adjudication window described in
# docs/roadmap/genlayer.md, so a slow-but-working resolution never races a
# premature cancellation. datetime.now() inside a contract follows the same
# precedent as genlayer-studio-bridge-boilerplate's BridgeSender.py.
RESOLUTION_TIMEOUT_HOURS = 48

# Content types this contract knows how to hand to an LLM. Anything else in
# an evidence envelope makes that envelope unsupported, not silently coerced.
SUPPORTED_TEXT_TYPES = ("application/json", "text/plain", "text/html")
SUPPORTED_IMAGE_TYPES = ("image/png", "image/jpeg")


@allow_storage
@dataclass
class Claim:
    request_id: str
    slug: str
    clause_id: str
    claimant: str
    criteria: str
    submitted_at: str
    resolved: bool
    outcome: str
    reasoning: str


class SlaClaimJudge(gl.Contract):
    claims: TreeMap[str, Claim]
    sla_api_base: str
    evidence_api_base: str
    resolution_timeout_hours: u256

    def __init__(
        self,
        sla_api_base: str,
        evidence_api_base: str,
        resolution_timeout_hours: u256 = u256(RESOLUTION_TIMEOUT_HOURS),
    ):
        self.claims = TreeMap()
        self.sla_api_base = sla_api_base
        self.evidence_api_base = evidence_api_base
        self.resolution_timeout_hours = resolution_timeout_hours

    @gl.public.write
    def submit_claim(self, request_id: str, slug: str, clause_id: str) -> None:
        """Open a claim and freeze the disputed clause's criteria.

        `request_id` correlates back to the Arc-side verdict/escrow entry for
        the same x402 call. Opening a claim is also the act that unlocks the
        evidence envelope on the proxy — nothing is servable before this call
        succeeds for this `request_id` (dispute-gated design). Keyed by
        `(request_id, clause_id)`: a verdict can carry several semantic
        clauses, each independently disputable.
        """
        key = _claim_key(request_id, clause_id)
        if key in self.claims:
            raise Exception("Claim already submitted for this request and clause")

        sla_url = f"{self.sla_api_base}/internal/sla/{slug}"

        def leader_fn() -> str:
            resp = gl.nondet.web.get(sla_url)
            sla_data = json.loads(resp.body.decode("utf-8", errors="replace"))
            sla_text = sla_data.get("sla") or ""
            if not sla_text:
                raise Exception("No SLA published for this service")
            clauses = json.loads(sla_text).get("clauses", [])
            for clause in clauses:
                if clause.get("id") == clause_id and clause.get("type") == "semantic":
                    return str(clause["criteria"])
            raise Exception(f'No semantic clause "{clause_id}" in this SLA')

        def validator_fn(leader_result) -> bool:
            # Exact match, not comparative: this is a data lookup (what text
            # is on ENS right now), not a judgment call — every honest
            # validator must read the identical criteria string.
            if not isinstance(leader_result, glvm.Return):
                return False
            return leader_fn() == leader_result.calldata

        criteria = glvm.run_nondet_unsafe(leader_fn, validator_fn)

        self.claims[key] = Claim(
            request_id=request_id,
            slug=slug,
            clause_id=clause_id,
            claimant=gl.message.sender_address.as_hex,
            criteria=criteria,
            submitted_at=datetime.now().isoformat(),
            resolved=False,
            outcome="",
            reasoning="",
        )

    @gl.public.write
    def resolve_claim(self, request_id: str, clause_id: str) -> None:
        key = _claim_key(request_id, clause_id)
        if key not in self.claims:
            raise Exception("Unknown claim")
        claim = self.claims[key]
        if claim.resolved:
            raise Exception("Claim already resolved")

        evidence_url = f"{self.evidence_api_base}/internal/evidence/{request_id}"
        criteria = claim.criteria

        def leader_fn() -> dict:
            resp = gl.nondet.web.get(evidence_url)
            if resp.status_code == 404:
                return {
                    "outcome": OUTCOME_UNDETERMINED,
                    "reasoning": "no evidence envelope available for this request",
                }
            envelope = json.loads(resp.body.decode("utf-8", errors="replace"))

            unsupported = _envelope_unsupported_reason(envelope)
            if unsupported is not None:
                return {"outcome": OUTCOME_UNDETERMINED, "reasoning": unsupported}

            response = envelope["response"]
            content_type = (response.get("contentType") or "").split(";")[0].strip()
            task = f"""
You are judging whether a service deliverable met one specific clause of its
declared SLA. Judge only the clause below — other clauses are handled
elsewhere and are not your concern.

Clause criteria (binding, authored by the provider):
{criteria}

Request: {envelope["request"]["method"]} {envelope["request"]["url"]}
Response status: {response["status"]}
"""
            if content_type in SUPPORTED_IMAGE_TYPES:
                import base64

                image_bytes = base64.b64decode(response["body"])
                result = gl.nondet.exec_prompt(
                    task
                    + '\nThe response body is the attached image. Respond in JSON: {"outcome": "MET" or "BREACH", "reasoning": str}. JSON only, no other text.',
                    images=[image_bytes],
                    response_format="json",
                )
            else:
                task += f"""
Response body:
{response["body"]}

Decide whether the response satisfies the clause criteria. Respond in JSON:
{{
    "outcome": "MET" or "BREACH",
    "reasoning": str
}}
It is mandatory that you respond only using the JSON format above, nothing
else. Don't include any other words or characters, your output must be only
JSON without any formatting prefix or suffix.
"""
                result = gl.nondet.exec_prompt(task, response_format="json")

            outcome = str(result["outcome"])
            if outcome not in (OUTCOME_MET, OUTCOME_BREACH):
                return {
                    "outcome": OUTCOME_UNDETERMINED,
                    "reasoning": f'model returned unrecognized outcome "{outcome}"',
                }
            return {"outcome": outcome, "reasoning": str(result["reasoning"])}

        def validator_fn(leader_result) -> bool:
            # Partial field matching (GenLayer's recommended pattern for
            # settlement decisions): re-derive independently, compare only the
            # decision field. `reasoning` is free text and may legitimately
            # differ between two independently-produced explanations.
            if not isinstance(leader_result, glvm.Return):
                return False
            my_result = leader_fn()
            return my_result["outcome"] == leader_result.calldata["outcome"]

        result = glvm.run_nondet_unsafe(leader_fn, validator_fn)

        claim.resolved = True
        claim.outcome = result["outcome"]
        claim.reasoning = result["reasoning"]
        self.claims[key] = claim

    @gl.public.write
    def cancel_claim(self, request_id: str, clause_id: str) -> None:
        """Permissionless cancellation once the resolution timeout has
        elapsed — for infrastructure failure (relay down, evidence expired,
        ENS unreachable, GenLayer consensus never completing), not a
        judgment. Without this, an unresolved claim would lock the
        claimant's bond indefinitely with no return path. Anyone may call
        this, mirroring GenLayer's own permissionless idleness-call pattern
        for stalled validator rounds — not a new access-control shape.
        """
        key = _claim_key(request_id, clause_id)
        if key not in self.claims:
            raise Exception("Unknown claim")
        claim = self.claims[key]
        if claim.resolved:
            raise Exception("Claim already resolved")

        deadline = datetime.fromisoformat(claim.submitted_at) + timedelta(hours=int(self.resolution_timeout_hours))
        if datetime.now() < deadline:
            raise Exception(f"Resolution timeout has not elapsed yet (deadline {deadline.isoformat()})")

        claim.resolved = True
        claim.outcome = OUTCOME_CANCELLED
        claim.reasoning = "resolution timeout elapsed — infrastructure failure, not a judgment"
        self.claims[key] = claim

    @gl.public.view
    def get_claim(self, request_id: str, clause_id: str) -> dict:
        key = _claim_key(request_id, clause_id)
        if key not in self.claims:
            raise Exception("Unknown claim")
        c = self.claims[key]
        return {
            "request_id": c.request_id,
            "slug": c.slug,
            "clause_id": c.clause_id,
            "claimant": c.claimant,
            "criteria": c.criteria,
            "submitted_at": c.submitted_at,
            "resolved": c.resolved,
            "outcome": c.outcome,
            "reasoning": c.reasoning,
        }


def _claim_key(request_id: str, clause_id: str) -> str:
    # One verdict can carry several semantic clauses; each is independently
    # disputable, so the claim key must include both, not request_id alone.
    return f"{request_id}:{clause_id}"


def _envelope_unsupported_reason(envelope: dict) -> str | None:
    """Pure structural/support check — same result for every validator given
    the same envelope, so it can run inside the nondet block without adding
    its own disagreement risk."""
    request = envelope.get("request")
    response = envelope.get("response")
    if not isinstance(request, dict) or not isinstance(response, dict):
        return "evidence envelope missing request or response"
    if response.get("status") is None:
        return "evidence envelope has no response (transport failure — DOWN, not a semantic dispute)"
    if response.get("body") is None:
        return "evidence envelope has no response body"
    content_type = (response.get("contentType") or "").split(";")[0].strip()
    if content_type not in SUPPORTED_TEXT_TYPES and content_type not in SUPPORTED_IMAGE_TYPES:
        return f'unsupported content type "{content_type}" — cannot judge this evidence format'
    return None
