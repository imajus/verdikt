"""
The judge's own bookkeeping: deposits bound to slugs, bonds committed per
claimant, open claims counted per slug.

What direct mode can reach here is the accounting, not the money. The token
calls behind `_escrow_of`/`_release` are cross-contract, which `gl_call` in
direct mode does not handle at all — so the fixtures below run with no token
configured, and every escrow read comes back zero. That is stated rather than
worked around: the arithmetic is in test_settlement.py and the wiring needs a
node (#85).
"""

import pytest

from tests.direct.conftest import (
    ARC_RPC,
    COOLDOWN,
    BOUNTY,
    CLAUSE_ID,
    FILING_WINDOW,
    PAID_AMOUNT,
    PROXY,
    REGISTRY,
    REQUEST_ID,
    SIGNATURE,
    SLUG,
    advance,
    mock_arc,
    mock_evidence,
    mock_judgment,
    mock_sla,
    load_judge_module,
    to_hex,
)

# The claim's own clock, mirrored from the contract so a change to the window
# there fails this file rather than silently changing what it proves.
ADJUDICATION_WINDOW_SECONDS = 24 * 60 * 60


def test_deposits_and_bonds_reserve_the_same_escrow(judge) -> None:
    """Neither commitment can be allocated a second time by the other path."""
    judge_module = load_judge_module()
    assert judge_module.available_escrow(10_000, deposits=7_000, bonds=3_000) == 0
    assert judge_module.available_escrow(10_000, deposits=7_000, bonds=2_000) == 1_000


@pytest.fixture
def bonded_judge(direct_deploy):
    """A judge that demands a bond, with no token to post one into."""
    return direct_deploy(
        'contracts/sla_claim_judge.py', PROXY, '', 1000, BOUNTY, REGISTRY, ARC_RPC, FILING_WINDOW, COOLDOWN
    )


def test_config_reports_the_economics(judge):
    config = judge.get_config()
    assert config['bounty_amount'] == BOUNTY
    assert config['bond_amount'] == 0
    assert config['token_address'] == ''


def test_an_open_claim_is_counted_against_its_slug(direct_vm, judge, direct_alice):
    direct_vm.sender = direct_alice
    mock_sla(direct_vm)
    mock_arc(direct_vm, payer=to_hex(direct_alice))
    judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    assert judge.get_deposit(SLUG)['open_claims'] == 1


def test_resolving_releases_the_count(direct_vm, judge, direct_alice):
    direct_vm.sender = direct_alice
    mock_sla(direct_vm)
    mock_arc(direct_vm, payer=to_hex(direct_alice))
    judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)
    mock_evidence(direct_vm)
    mock_judgment(direct_vm, 'MET')
    judge.resolve_claim(REQUEST_ID, CLAUSE_ID)

    assert judge.get_deposit(SLUG)['open_claims'] == 0


def test_cancelling_releases_the_count_too(direct_vm, judge, direct_alice):
    """An abandoned claim must not pin a provider's deposit forever."""
    direct_vm.sender = direct_alice
    mock_sla(direct_vm)
    mock_arc(direct_vm, payer=to_hex(direct_alice))
    judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)
    advance(direct_vm, ADJUDICATION_WINDOW_SECONDS + 1)
    judge.cancel_claim(REQUEST_ID, CLAUSE_ID)

    assert judge.get_deposit(SLUG)['open_claims'] == 0


def test_the_claim_records_what_the_call_cost(direct_vm, judge, direct_alice):
    direct_vm.sender = direct_alice
    mock_sla(direct_vm)
    mock_arc(direct_vm, payer=to_hex(direct_alice))
    judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    claim = judge.get_claim(REQUEST_ID, CLAUSE_ID)
    assert claim['paid_amount'] == PAID_AMOUNT
    assert claim['compensation'] == 0
    assert claim['bounty'] == 0


def test_a_malformed_request_id_refuses_before_any_fetch(direct_vm, judge, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert('Request id must be 32 bytes'):
        judge.submit_claim('0xdeadbeef', CLAUSE_ID, SLUG, SIGNATURE)


class TestBondRequired:
    # A judge that wants a bond and has no token to read cannot see one posted,
    # so it refuses everything. Stated as behaviour rather than treated as a
    # bug: the alternative is accepting claims backed by nothing.
    def test_a_claim_without_a_posted_bond_refuses(self, direct_vm, bonded_judge, direct_alice):
        direct_vm.sender = direct_alice
        mock_sla(direct_vm)
        mock_arc(direct_vm, payer=to_hex(direct_alice))
        with direct_vm.expect_revert('to post the bond'):
            bonded_judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    def test_nothing_is_fetched_when_the_bond_is_missing(self, direct_vm, bonded_judge, direct_alice):
        """The bond check comes before Arc and ENS, so a claimant with no stake costs nobody a fetch."""
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert('to post the bond'):
            bonded_judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    def test_nothing_is_bonded_by_a_judge_that_asks_for_no_bond(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        mock_sla(direct_vm)
        mock_arc(direct_vm, payer=to_hex(direct_alice))
        judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)
        assert judge.get_bonded(to_hex(direct_alice)) == 0


class TestDeposits:
    def test_funding_without_an_escrow_refuses(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert('Escrow settlement tokens'):
            judge.fund_deposit(SLUG)

    def test_an_unfunded_slug_reports_no_owner(self, judge):
        assert judge.get_deposit(SLUG) == {
            'slug': SLUG,
            'owner': None,
            'amount': 0,
            'open_claims': 0,
            'withdrawal_requested_at': 0,
            'withdrawable_at': 0,
        }

    def test_withdrawing_from_a_slug_with_no_deposit_refuses(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert('has no deposit'):
            judge.withdraw_deposit(SLUG)

    def test_config_reports_the_cooldown(self, judge):
        assert judge.get_config()['cooldown_seconds'] == COOLDOWN
