"""
The cross-contract half, which direct mode cannot reach at all.

`gl_call`'s `CallContract`/`PostMessage` operations are unhandled in direct
mode, so every test under tests/direct runs the judge with no token. This file
is where the judge and the token are actually wired to each other: minting,
escrowing a deposit, binding it to a slug, and getting it back out.

Needs a running node. `glsim` is the cheapest one:

    .venv/bin/glsim --port 4000 --no-browser --chain-id 61999 &
    .venv/bin/gltest tests/integration -v -s

Nothing here calls an LLM, so no provider key is needed. Judging a claim does,
and that is deliberately not tested here — it belongs on a real node with real
validators, which is the whole point of the judgment being non-deterministic.
"""

import os

import pytest
from gltest import get_contract_factory, get_default_account
from gltest.assertions import tx_execution_succeeded

SLUG = 'summarizer'
DEPOSIT = 5_000_000
BOND = 1_000_000
BOUNTY = 100_000
# Never reached here: nothing in this file opens a claim, which is the only
# path that reads a verdict.
REGISTRY = '0xE182626142E63EF440421cb0c5e4DEbeEF76E4Af'
FILING_WINDOW = 86_400
COOLDOWN = 3 * 86_400
# The cooldown does read a clock, and the clock is Arc's — the same one the
# filing deadline uses, because "the cooldown outlasts the filing window" is
# only a comparison if both are measured against the same thing. So this suite
# does reach the public internet, for one `eth_getBlockByNumber` per request.
ARC_RPC = os.environ.get('ARC_RPC_URL', 'https://arc-testnet.g.alchemy.com/v2/alch_Ycps6R4vs7fy-PQA7Tz9d')


@pytest.fixture
def deployed():
    token = get_contract_factory('SettlementToken').deploy(args=['Verdikt Settlement', 'VSET'])
    judge = get_contract_factory('SlaClaimJudge').deploy(
        args=[
            'https://proxy.invalid', token.address, BOND, BOUNTY,
            REGISTRY, ARC_RPC, FILING_WINDOW, COOLDOWN
        ]
    )
    return token, judge


@pytest.mark.integration
def test_the_judge_reads_the_token_it_was_given(deployed):
    token, judge = deployed
    assert judge.get_config(args=[]).call()['token_address'] == token.address


@pytest.mark.integration
def test_a_deposit_is_the_escrow_the_judge_can_see(deployed):
    token, judge = deployed
    me = get_default_account().address

    assert tx_execution_succeeded(token.mint(args=[DEPOSIT]).transact())
    assert tx_execution_succeeded(token.escrow(args=[judge.address, DEPOSIT]).transact())

    # The tokens have not moved: escrow hands over authority, not ownership.
    assert token.balance_of(args=[me]).call() == DEPOSIT
    assert token.available_of(args=[me]).call() == 0
    assert token.escrow_of(args=[me, judge.address]).call() == DEPOSIT

    assert tx_execution_succeeded(judge.fund_deposit(args=[SLUG]).transact())
    deposit = judge.get_deposit(args=[SLUG]).call()
    assert deposit['owner'] == me
    assert deposit['amount'] == DEPOSIT
    assert deposit['open_claims'] == 0


@pytest.mark.integration
def test_funding_without_an_escrow_refuses(deployed):
    _, judge = deployed
    assert not tx_execution_succeeded(judge.fund_deposit(args=['unfunded-slug']).transact())


@pytest.mark.integration
def test_a_deposit_cannot_be_withdrawn_before_its_cooldown(deployed):
    """The escape route the open-claims guard alone does not close: withdrawing
    before anybody has filed."""
    token, judge = deployed
    me = get_default_account().address

    token.mint(args=[DEPOSIT]).transact()
    token.escrow(args=[judge.address, DEPOSIT]).transact()
    judge.fund_deposit(args=[SLUG]).transact()

    # Straight to withdrawal, with no request: refused.
    assert not tx_execution_succeeded(judge.withdraw_deposit(args=[SLUG]).transact())
    assert token.escrow_of(args=[me, judge.address]).call() == DEPOSIT


@pytest.mark.integration
def test_a_second_judge_cannot_touch_the_first_judge_s_escrow(deployed):
    """`release` is custodian-scoped, and the custodian is whoever the escrow named."""
    token, judge = deployed
    other = get_contract_factory('SlaClaimJudge').deploy(
        args=[
            'https://proxy.invalid', token.address, BOND, BOUNTY,
            REGISTRY, ARC_RPC, FILING_WINDOW, COOLDOWN
        ]
    )
    me = get_default_account().address

    token.mint(args=[DEPOSIT]).transact()
    token.escrow(args=[judge.address, DEPOSIT]).transact()

    # `other` has no escrow of its own, so its deposit read is empty and its
    # withdrawal has nothing to release — the escrow stays where it was put.
    assert not tx_execution_succeeded(other.fund_deposit(args=[SLUG]).transact())
    assert token.escrow_of(args=[me, judge.address]).call() == DEPOSIT



# The two-step release past its cooldown is NOT tested here, and the reason is
# worth writing down rather than rediscovering: glsim reverts any write
# transaction that performs a nondet *web* call, at the EVM consensus layer,
# before the contract executes at all. Checked against a local HTTP stub as
# well as a real RPC, so it is neither the URL nor network egress.
#
# `request_withdrawal` reads Arc's clock, so it is on the wrong side of that
# line. What survives is the test above — withdrawal without a request, which
# short-circuits before the clock is read — plus the rules themselves as a pure
# function in tests/direct/test_cooldown.py.
