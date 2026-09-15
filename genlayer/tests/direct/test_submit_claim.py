"""Opening a claim: the SLA read, the criteria freeze, and what refuses."""

from tests.direct.conftest import (
    CLAUSE_ID,
    CRITERIA,
    REQUEST_ID,
    SIGNATURE,
    SLUG,
    mock_sla,
    sla_document,
    to_hex,
)


def test_submit_claim_freezes_the_criteria(direct_vm, judge, direct_alice):
    direct_vm.sender = direct_alice
    mock_sla(direct_vm)

    judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    claim = judge.get_claim(REQUEST_ID, CLAUSE_ID)
    assert claim['criteria'] == CRITERIA
    assert claim['outcome'] == 'OPEN'
    assert claim['resolved'] is False
    assert claim['claimant'] == to_hex(direct_alice)
    assert claim['slug'] == SLUG


def test_claim_key_is_composite(direct_vm, judge, direct_alice):
    """One verdict can carry several disputable clauses; each is its own claim."""
    direct_vm.sender = direct_alice
    mock_sla(direct_vm, sla={
        'version': 1,
        'clauses': [
            {'id': 'first', 'type': 'semantic', 'criteria': 'A'},
            {'id': 'second', 'type': 'semantic', 'criteria': 'B'},
        ],
    })

    judge.submit_claim(REQUEST_ID, 'first', SLUG, SIGNATURE)
    judge.submit_claim(REQUEST_ID, 'second', SLUG, SIGNATURE)

    assert judge.get_claim(REQUEST_ID, 'first')['criteria'] == 'A'
    assert judge.get_claim(REQUEST_ID, 'second')['criteria'] == 'B'
    assert len(judge.list_claims()) == 2


def test_duplicate_claim_refuses(direct_vm, judge, direct_alice):
    direct_vm.sender = direct_alice
    mock_sla(direct_vm)
    judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    with direct_vm.expect_revert('Claim already exists'):
        judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)


def test_unknown_clause_refuses(direct_vm, judge, direct_alice):
    direct_vm.sender = direct_alice
    mock_sla(direct_vm)

    with direct_vm.expect_revert('is not in the SLA'):
        judge.submit_claim(REQUEST_ID, 'no-such-clause', SLUG, SIGNATURE)


def test_deterministic_clause_refuses(direct_vm, judge, direct_alice):
    """CRE already judges these. Opening a dispute over one is a category error."""
    direct_vm.sender = direct_alice
    mock_sla(direct_vm, sla=sla_document(clause_type='latency'))

    with direct_vm.expect_revert('is not semantic'):
        judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)


def test_semantic_clause_without_criteria_refuses(direct_vm, judge, direct_alice):
    direct_vm.sender = direct_alice
    mock_sla(direct_vm, sla=sla_document(criteria=None))

    with direct_vm.expect_revert('declares no criteria'):
        judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)


def test_service_without_an_sla_refuses(direct_vm, judge, direct_alice):
    """The proxy answers 404 for an unknown slug and for one with no `sla` record alike."""
    direct_vm.sender = direct_alice
    mock_sla(direct_vm, status=404)

    with direct_vm.expect_revert('No SLA published'):
        judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)


def test_proxy_outage_is_transient_not_expected(direct_vm, judge, direct_alice):
    """The class of the failure is load-bearing: validators compare on it."""
    direct_vm.sender = direct_alice
    mock_sla(direct_vm, status=503)

    with direct_vm.expect_revert('[TRANSIENT]'):
        judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)


def test_a_claim_needs_a_disclosure_signature(direct_vm, judge, direct_alice):
    """Without it the evidence is never fetchable, so the claim is dead on arrival."""
    direct_vm.sender = direct_alice
    mock_sla(direct_vm)

    with direct_vm.expect_revert('Disclosure signature'):
        judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, '')
