"""The infrastructure-failure escape hatch."""

from tests.direct.conftest import CLAUSE_ID, REQUEST_ID, SLUG, mock_evidence, mock_judgment, mock_sla


def test_claimant_can_cancel_an_open_claim(direct_vm, judge, direct_alice):
    direct_vm.sender = direct_alice
    mock_sla(direct_vm)
    judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG)

    judge.cancel_claim(REQUEST_ID, CLAUSE_ID)

    claim = judge.get_claim(REQUEST_ID, CLAUSE_ID)
    assert claim['outcome'] == 'CANCELLED'
    assert claim['resolved'] is True


def test_a_stranger_cannot_cancel(direct_vm, judge, direct_alice, direct_bob):
    direct_vm.sender = direct_alice
    mock_sla(direct_vm)
    judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG)

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert('Only the claimant may cancel'):
        judge.cancel_claim(REQUEST_ID, CLAUSE_ID)


def test_a_resolved_claim_cannot_be_cancelled(direct_vm, judge, direct_alice):
    direct_vm.sender = direct_alice
    mock_sla(direct_vm)
    judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG)
    mock_evidence(direct_vm)
    mock_judgment(direct_vm, 'BREACH')
    judge.resolve_claim(REQUEST_ID, CLAUSE_ID)

    with direct_vm.expect_revert('Claim already resolved'):
        judge.cancel_claim(REQUEST_ID, CLAUSE_ID)
