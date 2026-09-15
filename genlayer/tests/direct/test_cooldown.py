"""
The withdrawal cooldown — the escape route the open-claims guard leaves open.

Refusing to release a deposit while claims are open only protects disputes
already filed. Without a cooldown a provider could take calls all day, watch for
trouble, and withdraw before anyone got around to filing. The cooldown removes
the timing advantage: by the time the deposit can leave, every call it backed
has passed its filing deadline.

`withdrawal_refusal` is pure for the same reason `settlement_for` and
`check_eligibility` are — it is where being wrong lets money escape. The
transfer it gates needs a token, so it lives in tests/integration.
"""

import pytest

from tests.direct.conftest import (
    ARC_RPC,
    BOUNTY,
    CLOCK_BUCKET,
    COOLDOWN,
    FILING_WINDOW,
    NOW,
    PROXY,
    REGISTRY,
    SLUG,
    load_judge_module,
)


@pytest.fixture
def judge_module(judge):
    return load_judge_module()


class TestConfiguration:
    # A cooldown shorter than the window it exists to outlast is not a shorter
    # cooldown — it is no cooldown, and it would look configured.
    def test_refuses_a_cooldown_that_does_not_outlast_the_exposure(self, direct_deploy):
        with pytest.raises(Exception, match='at least twice'):
            direct_deploy(
                'contracts/sla_claim_judge.py', PROXY, '', 0, BOUNTY, REGISTRY, ARC_RPC, FILING_WINDOW, FILING_WINDOW
            )

    def test_accepts_a_cooldown_exactly_at_the_floor(self, direct_deploy):
        judge = direct_deploy(
            'contracts/sla_claim_judge.py', PROXY, '', 0, BOUNTY, REGISTRY, ARC_RPC, FILING_WINDOW, FILING_WINDOW * 2
        )
        assert judge.get_config()['cooldown_seconds'] == FILING_WINDOW * 2

    def test_reports_the_cooldown_it_was_given(self, judge):
        assert judge.get_config()['cooldown_seconds'] == COOLDOWN


class TestTheRule:
    def test_lets_a_settled_deposit_past_its_cooldown_go(self, judge_module):
        assert judge_module.withdrawal_refusal(open_claims=0, requested_at=NOW, cooldown_elapsed=True) is None

    def test_refuses_while_a_claim_is_open(self, judge_module):
        refusal = judge_module.withdrawal_refusal(open_claims=1, requested_at=NOW, cooldown_elapsed=True)
        assert refusal is not None and 'open claims' in refusal

    def test_refuses_a_withdrawal_nobody_requested(self, judge_module):
        refusal = judge_module.withdrawal_refusal(open_claims=0, requested_at=0, cooldown_elapsed=True)
        assert refusal is not None and 'request_withdrawal' in refusal

    def test_refuses_before_the_cooldown_is_up(self, judge_module):
        refusal = judge_module.withdrawal_refusal(open_claims=0, requested_at=NOW, cooldown_elapsed=False)
        assert refusal is not None and 'cooldown' in refusal

    # The open-claims guard is checked first, so a provider with both problems
    # is told about the one that will not pass with time.
    def test_names_the_open_claim_ahead_of_the_cooldown(self, judge_module):
        refusal = judge_module.withdrawal_refusal(open_claims=2, requested_at=0, cooldown_elapsed=False)
        assert 'open claims' in refusal


class TestTheClock:
    """Arc's clock, coarsened before any validator sees it.

    A raw timestamp returned under `strict_eq` would make two validators
    reading a block a second apart disagree on every call, and the cooldown
    would never start. The bucket is what they can agree on.
    """

    def test_two_validators_seconds_apart_land_in_the_same_bucket(self, judge_module):
        bucket = judge_module.CLOCK_BUCKET_SECONDS
        leader = NOW - (NOW % bucket) + 5
        validator = leader + 3
        assert leader - (leader % bucket) == validator - (validator % bucket)

    def test_the_bucket_is_negligible_against_the_cooldown(self, judge_module):
        # Ten minutes on a multi-day cooldown is immaterial; disagreeing on
        # every call is not.
        assert judge_module.CLOCK_BUCKET_SECONDS == CLOCK_BUCKET
        assert judge_module.CLOCK_BUCKET_SECONDS * 100 < COOLDOWN


class TestAccessControl:
    def test_only_a_funded_slug_can_have_a_withdrawal_requested(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert('has no deposit'):
            judge.request_withdrawal(SLUG)

    def test_cancelling_a_withdrawal_on_an_unfunded_slug_refuses(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert('has no deposit'):
            judge.cancel_withdrawal(SLUG)

    # No Arc mock is registered in this file. A clean refusal rather than a
    # missing-mock error means nothing reached out: an unauthorised caller
    # costs nobody a fetch.
    def test_nothing_reads_the_clock_before_the_caller_is_checked(self, direct_vm, judge, direct_bob):
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert('has no deposit'):
            judge.withdraw_deposit(SLUG)

    def test_an_unfunded_slug_reports_no_pending_withdrawal(self, judge):
        deposit = judge.get_deposit(SLUG)
        assert deposit['withdrawal_requested_at'] == 0
        assert deposit['withdrawable_at'] == 0
