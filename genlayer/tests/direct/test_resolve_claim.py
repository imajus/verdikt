"""Judging a claim: the three outcomes, and every path that must not force one."""

from tests.direct.conftest import (
    CLAUSE_ID,
    REQUEST_ID,
    SLUG,
    evidence_envelope,
    mock_evidence,
    mock_judgment,
    mock_sla,
)


def _open_claim(direct_vm, judge, sender):
    direct_vm.sender = sender
    mock_sla(direct_vm)
    judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG)


def test_breach(direct_vm, judge, direct_alice):
    _open_claim(direct_vm, judge, direct_alice)
    mock_evidence(direct_vm)
    mock_judgment(direct_vm, 'BREACH', 'The summary describes a different document.')

    judge.resolve_claim(REQUEST_ID, CLAUSE_ID)

    claim = judge.get_claim(REQUEST_ID, CLAUSE_ID)
    assert claim['outcome'] == 'BREACH'
    assert claim['resolved'] is True
    assert 'different document' in claim['reasoning']


def test_met(direct_vm, judge, direct_alice):
    _open_claim(direct_vm, judge, direct_alice)
    mock_evidence(direct_vm)
    mock_judgment(direct_vm, 'MET')

    judge.resolve_claim(REQUEST_ID, CLAUSE_ID)

    assert judge.get_claim(REQUEST_ID, CLAUSE_ID)['outcome'] == 'MET'


def test_missing_evidence_is_undetermined_not_breach(direct_vm, judge, direct_alice):
    """A provider must not lose a dispute because the evidence never arrived."""
    _open_claim(direct_vm, judge, direct_alice)
    mock_evidence(direct_vm, status=404)

    judge.resolve_claim(REQUEST_ID, CLAUSE_ID)

    claim = judge.get_claim(REQUEST_ID, CLAUSE_ID)
    assert claim['outcome'] == 'UNDETERMINED'
    assert claim['resolved'] is True


def test_unsupported_content_type_is_undetermined(direct_vm, judge, direct_alice):
    _open_claim(direct_vm, judge, direct_alice)
    mock_evidence(direct_vm, envelope=evidence_envelope(content_type='application/octet-stream'))

    judge.resolve_claim(REQUEST_ID, CLAUSE_ID)

    assert judge.get_claim(REQUEST_ID, CLAUSE_ID)['outcome'] == 'UNDETERMINED'


def test_image_evidence_is_undetermined_for_now(direct_vm, judge, direct_alice):
    _open_claim(direct_vm, judge, direct_alice)
    mock_evidence(direct_vm, envelope=evidence_envelope(content_type='image/png'))

    judge.resolve_claim(REQUEST_ID, CLAUSE_ID)

    assert judge.get_claim(REQUEST_ID, CLAUSE_ID)['outcome'] == 'UNDETERMINED'


def test_empty_body_is_undetermined(direct_vm, judge, direct_alice):
    _open_claim(direct_vm, judge, direct_alice)
    mock_evidence(direct_vm, envelope=evidence_envelope(response_body=''))

    judge.resolve_claim(REQUEST_ID, CLAUSE_ID)

    assert judge.get_claim(REQUEST_ID, CLAUSE_ID)['outcome'] == 'UNDETERMINED'


def test_content_type_with_charset_still_judged(direct_vm, judge, direct_alice):
    _open_claim(direct_vm, judge, direct_alice)
    mock_evidence(direct_vm, envelope=evidence_envelope(content_type='application/json; charset=utf-8'))
    mock_judgment(direct_vm, 'MET')

    judge.resolve_claim(REQUEST_ID, CLAUSE_ID)

    assert judge.get_claim(REQUEST_ID, CLAUSE_ID)['outcome'] == 'MET'


def test_llm_naming_no_known_outcome_fails_loudly(direct_vm, judge, direct_alice):
    """Silently defaulting a garbled judgment to any outcome would settle money on noise."""
    _open_claim(direct_vm, judge, direct_alice)
    mock_evidence(direct_vm)
    mock_judgment(direct_vm, 'PROBABLY_FINE')

    with direct_vm.expect_revert('[LLM_ERROR]'):
        judge.resolve_claim(REQUEST_ID, CLAUSE_ID)


def test_resolving_twice_refuses(direct_vm, judge, direct_alice):
    _open_claim(direct_vm, judge, direct_alice)
    mock_evidence(direct_vm)
    mock_judgment(direct_vm, 'MET')
    judge.resolve_claim(REQUEST_ID, CLAUSE_ID)

    with direct_vm.expect_revert('Claim already resolved'):
        judge.resolve_claim(REQUEST_ID, CLAUSE_ID)


def test_resolving_an_unknown_claim_refuses(direct_vm, judge, direct_alice):
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert('No such claim'):
        judge.resolve_claim(REQUEST_ID, CLAUSE_ID)
