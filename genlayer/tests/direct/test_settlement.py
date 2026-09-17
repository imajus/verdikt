"""
Who pays what, for every outcome and every shortfall.

`settlement_for` is pure on purpose — no storage, no I/O, no clock — for the
same reason `evaluate` is pure on the deterministic side: it is the part where
being wrong costs somebody money, and it is the only part direct mode can hold
to account. The cross-contract wiring around it needs a real node (#85).
"""

import pytest

from tests.direct.conftest import load_judge_module

PAID = 2500
BOND = 1000
BOUNTY = 100


@pytest.fixture
def settlement_for(judge):
    # `judge` only to make sure something has been deployed: the SDK reaches
    # sys.path as a side effect of deployment, and the contract module imports it.
    return load_judge_module().settlement_for


class TestBreach:
    """The provider's deposit pays; the consumer's bond comes back untouched."""

    def test_pays_compensation_and_bounty_from_the_deposit(self, settlement_for):
        plan = settlement_for(
            outcome='BREACH', paid_amount=PAID, deposit_available=10_000, bond=BOND, bounty=BOUNTY
        )
        assert plan == {'compensation': PAID, 'bounty': BOUNTY, 'from_provider': PAID + BOUNTY, 'from_consumer': 0}

    # Never a penalty on top of the payment. The deterministic side caps refunds
    # at the amount paid for exactly this reason: a payout larger than the call
    # makes induced-failure griefing profitable, and there is no arbitration
    # step to fall back on.
    def test_never_pays_more_than_the_call_cost(self, settlement_for):
        plan = settlement_for(
            outcome='BREACH', paid_amount=PAID, deposit_available=10**9, bond=BOND, bounty=BOUNTY
        )
        assert plan['compensation'] == PAID

    def test_clamps_to_a_deposit_that_cannot_cover_it(self, settlement_for):
        plan = settlement_for(outcome='BREACH', paid_amount=PAID, deposit_available=900, bond=BOND, bounty=BOUNTY)
        assert plan['compensation'] == 900
        assert plan['bounty'] == 0
        assert plan['from_provider'] == 900

    # Compensation is the point of the claim; the bounty is the cost of
    # processing it. On a deposit too small for both, the claimant is made as
    # whole as the bond allows and whoever resolved it goes unpaid.
    def test_pays_compensation_before_the_bounty(self, settlement_for):
        plan = settlement_for(
            outcome='BREACH', paid_amount=PAID, deposit_available=PAID + 40, bond=BOND, bounty=BOUNTY
        )
        assert plan['compensation'] == PAID
        assert plan['bounty'] == 40

    # A judgment is recorded whether or not funds backed it. A provider that
    # could erase a finding by being broke would have every reason to be broke.
    def test_an_empty_deposit_settles_to_nothing_rather_than_failing(self, settlement_for):
        plan = settlement_for(outcome='BREACH', paid_amount=PAID, deposit_available=0, bond=BOND, bounty=BOUNTY)
        assert plan == {'compensation': 0, 'bounty': 0, 'from_provider': 0, 'from_consumer': 0}


class TestMet:
    """The claim failed: the consumer's bond pays the bounty and the rest returns."""

    def test_pays_the_bounty_from_the_bond(self, settlement_for):
        plan = settlement_for(outcome='MET', paid_amount=PAID, deposit_available=10_000, bond=BOND, bounty=BOUNTY)
        assert plan == {'compensation': 0, 'bounty': BOUNTY, 'from_provider': 0, 'from_consumer': BOUNTY}

    def test_takes_no_more_than_the_bond(self, settlement_for):
        plan = settlement_for(outcome='MET', paid_amount=PAID, deposit_available=10_000, bond=30, bounty=BOUNTY)
        assert plan['from_consumer'] == 30

    def test_the_provider_pays_nothing(self, settlement_for):
        plan = settlement_for(outcome='MET', paid_amount=PAID, deposit_available=10_000, bond=BOND, bounty=BOUNTY)
        assert plan['from_provider'] == 0


class TestNobodyPays:
    """
    `UNDETERMINED` charges neither side, and that is load-bearing.

    Charging the provider would make missing evidence adjudicable, and
    therefore worth manufacturing. Charging the claimant would make an
    infrastructure failure their fault. They absorb their own gas, which is
    already the cost of trying.
    """

    @pytest.mark.parametrize('outcome', ['UNDETERMINED', 'CANCELLED', 'OPEN', 'nonsense'])
    def test_moves_nothing(self, settlement_for, outcome):
        plan = settlement_for(
            outcome=outcome, paid_amount=PAID, deposit_available=10_000, bond=BOND, bounty=BOUNTY
        )
        assert plan == {'compensation': 0, 'bounty': 0, 'from_provider': 0, 'from_consumer': 0}
