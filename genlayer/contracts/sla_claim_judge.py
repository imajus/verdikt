# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
SlaClaimJudge — GenLayer counterpart to Verdikt's Chainlink CRE workflow.

CRE evaluates deterministic, schema-checkable SLA clauses on every x402 call
(status codes, latency, price) and stays untouched by this contract. This
contract handles the claim types CRE cannot: a deliverable whose compliance
requires judgment rather than a schema match (does the response content
actually satisfy what was promised, does submitted evidence show what it
claims to show). It is a second claim-type handler on the same marketplace,
not a replacement.

Per spec (`docs/Specification.md` §3-4), the SLA is never duplicated on Arc —
it lives only as the `sla` text record on `<slug>.verdikt.eth` (ENSv2,
Sepolia), and `packages/sdk/ens.js` is the only file in the JS codebase
allowed to know ENS exists. GenVM cannot import that module, so this contract
reaches the same data through a small read-only endpoint the proxy exposes
(`GET {sla_api_base}/internal/sla/<slug>`) that wraps `resolveServiceRecord`
rather than re-deriving ENSv2's UniversalResolver ABI encoding inside GenVM.
That endpoint is tracked separately (Day 2) — this contract only assumes its
shape: `{"sla": str | null, "url": str | null}`.

The evidence itself (the deliverable content being judged) is never on any
chain — Verdikt's CRE workflow evaluates response bodies in flight and does
not persist them — so the claimant submits it directly as a call argument.
"""

import json
from dataclasses import dataclass
from genlayer import *
import genlayer.gl.vm as glvm


@allow_storage
@dataclass
class Claim:
    request_id: str
    slug: str
    claimant: str
    evidence: str
    resolved: bool
    verdict: bool
    reasoning: str


class SlaClaimJudge(gl.Contract):
    claims: TreeMap[str, Claim]
    sla_api_base: str

    def __init__(self, sla_api_base: str):
        self.claims = TreeMap()
        self.sla_api_base = sla_api_base

    @gl.public.write
    def submit_claim(self, request_id: str, slug: str, evidence: str) -> None:
        """Open a claim for a non-deterministic SLA judgment.

        `request_id` correlates back to the Arc-side verdict/escrow entry for
        the same x402 call. `evidence` is whatever the claimant has of the
        actual deliverable (response excerpt, description, screenshot
        reference) — Verdikt itself never stores it, so it travels with the
        claim.
        """
        if request_id in self.claims:
            raise Exception("Claim already submitted for this request")
        if not evidence:
            raise Exception("Evidence is required")
        self.claims[request_id] = Claim(
            request_id=request_id,
            slug=slug,
            claimant=gl.message.sender_address.as_hex,
            evidence=evidence,
            resolved=False,
            verdict=False,
            reasoning="",
        )

    @gl.public.write
    def resolve_claim(self, request_id: str) -> None:
        if request_id not in self.claims:
            raise Exception("Unknown claim")
        claim = self.claims[request_id]
        if claim.resolved:
            raise Exception("Claim already resolved")

        sla_url = f"{self.sla_api_base}/internal/sla/{claim.slug}"
        evidence = claim.evidence

        def leader_fn() -> dict:
            resp = gl.nondet.web.get(sla_url)
            sla_data = json.loads(resp.body.decode("utf-8", errors="replace"))
            sla_text = sla_data.get("sla") or ""
            if not sla_text:
                raise Exception("No SLA published for this service")

            task = f"""
You are judging whether a service deliverable met its declared SLA.

Declared SLA (JSON, authored by the provider):
{sla_text}

Evidence of what was actually delivered:
{evidence}

Decide whether the evidence satisfies the SLA. Respond in JSON:
{{
    "verdict": bool,
    "reasoning": str
}}
It is mandatory that you respond only using the JSON format above, nothing
else. Don't include any other words or characters, your output must be only
JSON without any formatting prefix or suffix. This result should be
perfectly parsable by a JSON parser without errors.
"""
            result = gl.nondet.exec_prompt(task, response_format="json")
            return {
                "verdict": bool(result["verdict"]),
                "reasoning": str(result["reasoning"]),
            }

        def validator_fn(leader_result) -> bool:
            # Partial field matching (GenLayer's recommended pattern for
            # settlement decisions): the validator independently re-derives
            # the same judgment and compares only the decision field.
            # `reasoning` is free text where two independently-produced but
            # equally valid explanations can differ, so it is not compared.
            if not isinstance(leader_result, glvm.Return):
                return False
            my_result = leader_fn()
            return my_result["verdict"] == leader_result.calldata["verdict"]

        outcome = glvm.run_nondet_unsafe(leader_fn, validator_fn)

        claim.resolved = True
        claim.verdict = outcome["verdict"]
        claim.reasoning = outcome["reasoning"]
        self.claims[request_id] = claim

    @gl.public.view
    def get_claim(self, request_id: str) -> dict:
        if request_id not in self.claims:
            raise Exception("Unknown claim")
        c = self.claims[request_id]
        return {
            "request_id": c.request_id,
            "slug": c.slug,
            "claimant": c.claimant,
            "evidence": c.evidence,
            "resolved": c.resolved,
            "verdict": c.verdict,
            "reasoning": c.reasoning,
        }
