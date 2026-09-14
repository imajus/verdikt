"""Direct-mode tests for SlaClaimJudge — no Studio required."""

import base64
import json

from tests.direct.conftest import to_hex

SLA_API_BASE = "https://proxy.verdikt.bond"
EVIDENCE_API_BASE = "https://proxy.verdikt.bond"
SLUG = "acme-flights"
CLAUSE_ID = "quality"
CRITERIA = "The response must contain a confirmed booking reference, not a placeholder."
SLA_TEXT = json.dumps(
    {
        "version": 1,
        "clauses": [
            {"id": "speed", "type": "latency", "maxMs": 2000},
            {"id": CLAUSE_ID, "type": "semantic", "criteria": CRITERIA},
        ],
    }
)

# Minimal valid 1x1 PNG, for the image-evidence path.
_VALID_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAA"
    "DElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
)


def _mock_sla(vm, sla_text=SLA_TEXT):
    vm.mock_web(
        r".*/internal/sla/.*",
        {"status": 200, "body": json.dumps({"sla": sla_text, "url": "https://acme.example/flights"})},
    )


def _envelope(**overrides):
    base = {
        "request": {"method": "GET", "url": "https://acme.example/flights?id=1", "body": None},
        "response": {
            "status": 200,
            "contentType": "application/json",
            "body": json.dumps({"bookingReference": "ABC123"}),
            "bodyEncoding": "utf8",
        },
    }
    base.update(overrides)
    return base


def _mock_evidence(vm, envelope, status=200):
    vm.mock_web(r".*/internal/evidence/.*", {"status": status, "body": json.dumps(envelope)})


def _mock_verdict(vm, outcome, reasoning="because the evidence says so"):
    vm.mock_llm(
        r".*judging whether a service deliverable.*",
        json.dumps({"outcome": outcome, "reasoning": reasoning}),
    )


def _deploy(direct_deploy):
    return direct_deploy(
        "contracts/sla_claim_judge.py", args=[SLA_API_BASE, EVIDENCE_API_BASE]
    )


def test_submit_claim_freezes_criteria(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy)
    direct_vm.sender = direct_alice
    alice = to_hex(direct_alice)
    _mock_sla(direct_vm)

    contract.submit_claim("req-1", SLUG, CLAUSE_ID)

    claim = contract.get_claim("req-1")
    assert claim["slug"] == SLUG
    assert claim["clause_id"] == CLAUSE_ID
    assert claim["claimant"] == alice
    assert claim["criteria"] == CRITERIA
    assert claim["resolved"] is False


def test_submit_claim_duplicate_request_id_fails(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy)
    direct_vm.sender = direct_alice
    _mock_sla(direct_vm)

    contract.submit_claim("req-1", SLUG, CLAUSE_ID)
    with direct_vm.expect_revert("Claim already submitted for this request"):
        contract.submit_claim("req-1", SLUG, CLAUSE_ID)


def test_submit_claim_unknown_clause_fails(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy)
    direct_vm.sender = direct_alice
    _mock_sla(direct_vm)

    with direct_vm.expect_revert('No semantic clause "missing" in this SLA'):
        contract.submit_claim("req-1", SLUG, "missing")


def test_resolve_claim_met(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy)
    direct_vm.sender = direct_alice
    _mock_sla(direct_vm)
    contract.submit_claim("req-1", SLUG, CLAUSE_ID)

    _mock_evidence(direct_vm, _envelope())
    _mock_verdict(direct_vm, "MET", "booking reference present, clause satisfied")

    contract.resolve_claim("req-1")

    claim = contract.get_claim("req-1")
    assert claim["resolved"] is True
    assert claim["outcome"] == "MET"
    assert "satisfied" in claim["reasoning"]


def test_resolve_claim_breach(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy)
    direct_vm.sender = direct_alice
    _mock_sla(direct_vm)
    contract.submit_claim("req-1", SLUG, CLAUSE_ID)

    _mock_evidence(direct_vm, _envelope(response={
        "status": 200, "contentType": "application/json",
        "body": json.dumps({"bookingReference": None}), "bodyEncoding": "utf8"
    }))
    _mock_verdict(direct_vm, "BREACH", "no booking reference found, clause violated")

    contract.resolve_claim("req-1")

    claim = contract.get_claim("req-1")
    assert claim["resolved"] is True
    assert claim["outcome"] == "BREACH"
    assert "violated" in claim["reasoning"]


def test_resolve_claim_image_evidence(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy)
    direct_vm.sender = direct_alice
    _mock_sla(direct_vm)
    contract.submit_claim("req-1", SLUG, CLAUSE_ID)

    envelope = _envelope(response={
        "status": 200,
        "contentType": "image/png",
        "body": _VALID_PNG_B64,
        "bodyEncoding": "base64",
    })
    _mock_evidence(direct_vm, envelope)
    _mock_verdict(direct_vm, "MET", "image shows the promised receipt")

    contract.resolve_claim("req-1")

    claim = contract.get_claim("req-1")
    assert claim["outcome"] == "MET"


def test_resolve_claim_no_envelope_is_undetermined(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy)
    direct_vm.sender = direct_alice
    _mock_sla(direct_vm)
    contract.submit_claim("req-1", SLUG, CLAUSE_ID)

    _mock_evidence(direct_vm, {}, status=404)

    contract.resolve_claim("req-1")

    claim = contract.get_claim("req-1")
    assert claim["resolved"] is True
    assert claim["outcome"] == "UNDETERMINED"


def test_resolve_claim_unsupported_content_type_is_undetermined(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy)
    direct_vm.sender = direct_alice
    _mock_sla(direct_vm)
    contract.submit_claim("req-1", SLUG, CLAUSE_ID)

    envelope = _envelope(response={
        "status": 200,
        "contentType": "application/pdf",
        "body": "…",
        "bodyEncoding": "base64",
    })
    _mock_evidence(direct_vm, envelope)

    contract.resolve_claim("req-1")

    claim = contract.get_claim("req-1")
    assert claim["resolved"] is True
    assert claim["outcome"] == "UNDETERMINED"
    assert "unsupported content type" in claim["reasoning"]


def test_resolve_claim_transport_failure_is_undetermined(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy)
    direct_vm.sender = direct_alice
    _mock_sla(direct_vm)
    contract.submit_claim("req-1", SLUG, CLAUSE_ID)

    envelope = _envelope(response={"status": None, "contentType": None, "body": None, "bodyEncoding": "utf8"})
    _mock_evidence(direct_vm, envelope)

    contract.resolve_claim("req-1")

    claim = contract.get_claim("req-1")
    assert claim["outcome"] == "UNDETERMINED"
    assert "DOWN" in claim["reasoning"] or "transport" in claim["reasoning"]


def test_resolve_claim_already_resolved_fails(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy)
    direct_vm.sender = direct_alice
    _mock_sla(direct_vm)
    contract.submit_claim("req-1", SLUG, CLAUSE_ID)
    _mock_evidence(direct_vm, _envelope())
    _mock_verdict(direct_vm, "MET")
    contract.resolve_claim("req-1")

    with direct_vm.expect_revert("Claim already resolved"):
        contract.resolve_claim("req-1")


def test_resolve_claim_unknown_request_fails(direct_vm, direct_deploy, direct_alice):
    contract = _deploy(direct_deploy)
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert("Unknown claim"):
        contract.resolve_claim("does-not-exist")
