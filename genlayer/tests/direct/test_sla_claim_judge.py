"""Direct-mode tests for SlaClaimJudge — no Studio required."""

import json

from tests.direct.conftest import to_hex

SLA_API_BASE = "https://proxy.verdikt.bond"
SLUG = "acme-flights"
SLA_TEXT = json.dumps(
    {
        "clauses": [
            {
                "id": "delivery",
                "description": "Response must contain a confirmed booking reference",
            }
        ]
    }
)


def _mock_sla(vm, sla_text=SLA_TEXT):
    vm.mock_web(
        r".*/internal/sla/.*",
        {"status": 200, "body": json.dumps({"sla": sla_text, "url": "https://acme.example/flights"})},
    )


def _mock_verdict(vm, verdict, reasoning="matches the declared clause"):
    vm.mock_llm(
        r".*judging whether a service deliverable.*",
        json.dumps({"verdict": verdict, "reasoning": reasoning}),
    )


def test_submit_claim_stores_evidence(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/sla_claim_judge.py", args=[SLA_API_BASE])
    direct_vm.sender = direct_alice
    alice = to_hex(direct_alice)

    contract.submit_claim("req-1", SLUG, "booking reference: ABC123")

    claim = contract.get_claim("req-1")
    assert claim["slug"] == SLUG
    assert claim["claimant"] == alice
    assert claim["evidence"] == "booking reference: ABC123"
    assert claim["resolved"] is False


def test_submit_claim_requires_evidence(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/sla_claim_judge.py", args=[SLA_API_BASE])
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert("Evidence is required"):
        contract.submit_claim("req-1", SLUG, "")


def test_submit_claim_duplicate_request_id_fails(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/sla_claim_judge.py", args=[SLA_API_BASE])
    direct_vm.sender = direct_alice

    contract.submit_claim("req-1", SLUG, "booking reference: ABC123")
    with direct_vm.expect_revert("Claim already submitted for this request"):
        contract.submit_claim("req-1", SLUG, "different evidence")


def test_resolve_claim_verdict_met(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/sla_claim_judge.py", args=[SLA_API_BASE])
    direct_vm.sender = direct_alice

    contract.submit_claim("req-1", SLUG, "booking reference: ABC123")
    _mock_sla(direct_vm)
    _mock_verdict(direct_vm, True, "booking reference present, clause satisfied")

    contract.resolve_claim("req-1")

    claim = contract.get_claim("req-1")
    assert claim["resolved"] is True
    assert claim["verdict"] is True
    assert "satisfied" in claim["reasoning"]


def test_resolve_claim_verdict_breach(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/sla_claim_judge.py", args=[SLA_API_BASE])
    direct_vm.sender = direct_alice

    contract.submit_claim("req-1", SLUG, "no booking reference in response")
    _mock_sla(direct_vm)
    _mock_verdict(direct_vm, False, "no booking reference found, clause violated")

    contract.resolve_claim("req-1")

    claim = contract.get_claim("req-1")
    assert claim["resolved"] is True
    assert claim["verdict"] is False
    assert "violated" in claim["reasoning"]


def test_resolve_claim_no_sla_published_fails(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/sla_claim_judge.py", args=[SLA_API_BASE])
    direct_vm.sender = direct_alice

    contract.submit_claim("req-1", SLUG, "booking reference: ABC123")
    vm_response = {"status": 200, "body": json.dumps({"sla": None, "url": None})}
    direct_vm.mock_web(r".*/internal/sla/.*", vm_response)

    with direct_vm.expect_revert("No SLA published for this service"):
        contract.resolve_claim("req-1")


def test_resolve_claim_already_resolved_fails(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/sla_claim_judge.py", args=[SLA_API_BASE])
    direct_vm.sender = direct_alice

    contract.submit_claim("req-1", SLUG, "booking reference: ABC123")
    _mock_sla(direct_vm)
    _mock_verdict(direct_vm, True)
    contract.resolve_claim("req-1")

    with direct_vm.expect_revert("Claim already resolved"):
        contract.resolve_claim("req-1")


def test_resolve_claim_unknown_request_fails(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/sla_claim_judge.py", args=[SLA_API_BASE])
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert("Unknown claim"):
        contract.resolve_claim("does-not-exist")
