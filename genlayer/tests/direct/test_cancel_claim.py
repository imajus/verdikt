"""The infrastructure-failure escape hatch, and the window that keeps it one."""

from tests.direct.conftest import (
    CLAUSE_ID,
    REQUEST_ID,
    SIGNATURE,
    SLUG,
    advance,
    mock_arc,
    mock_evidence,
    mock_judgment,
    mock_sla,
    to_hex,
)

WINDOW = 24 * 60 * 60


def _open_claim(direct_vm, judge, sender):
    direct_vm.sender = sender
    mock_sla(direct_vm)
    mock_arc(direct_vm, payer=to_hex(sender))
    judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)


def test_claimant_can_cancel_once_the_window_has_lapsed(direct_vm, judge, direct_alice):
    _open_claim(direct_vm, judge, direct_alice)
    advance(direct_vm, WINDOW + 1)

    judge.cancel_claim(REQUEST_ID, CLAUSE_ID)

    claim = judge.get_claim(REQUEST_ID, CLAUSE_ID)
    assert claim['outcome'] == 'CANCELLED'
    assert claim['resolved'] is True


def test_cancelling_inside_the_window_refuses(direct_vm, judge, direct_alice):
    """Otherwise cancelling is a free option: read the evidence, then withdraw."""
    _open_claim(direct_vm, judge, direct_alice)
    # An hour inside the window, not a minute: the contract's clock is Arc's
    # floored to CLOCK_BUCKET_SECONDS (600), so a 60-second margin rounds onto
    # the deadline itself and stops testing anything. The coarseness is the
    # deliberate price of a clock every validator agrees on.
    advance(direct_vm, WINDOW - 3600)

    with direct_vm.expect_revert('Adjudication window has not lapsed'):
        judge.cancel_claim(REQUEST_ID, CLAUSE_ID)


def test_a_stranger_cannot_cancel(direct_vm, judge, direct_alice, direct_bob):
    _open_claim(direct_vm, judge, direct_alice)
    advance(direct_vm, WINDOW + 1)

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert('Only the claimant may cancel'):
        judge.cancel_claim(REQUEST_ID, CLAUSE_ID)


def test_a_resolved_claim_cannot_be_cancelled(direct_vm, judge, direct_alice):
    _open_claim(direct_vm, judge, direct_alice)
    mock_evidence(direct_vm)
    mock_judgment(direct_vm, 'BREACH')
    judge.resolve_claim(REQUEST_ID, CLAUSE_ID)
    advance(direct_vm, WINDOW + 1)

    with direct_vm.expect_revert('Claim already resolved'):
        judge.cancel_claim(REQUEST_ID, CLAUSE_ID)