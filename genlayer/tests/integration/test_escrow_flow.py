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

import pytest
from gltest import get_contract_factory, get_default_account
from gltest.assertions import tx_execution_succeeded

SLUG = 'summarizer'
DEPOSIT = 5_000_000
BOND = 1_000_000
BOUNTY = 100_000


@pytest.fixture
def deployed():
    token = get_contract_factory('SettlementToken').deploy(args=['Verdikt Settlement', 'VSET'])
    judge = get_contract_factory('SlaClaimJudge').deploy(
        args=['https://proxy.invalid', token.address, BOND, BOUNTY]
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
def test_withdrawing_returns_the_escrow_through_the_custodian(deployed):
    """There is no owner-side unescrow; asking the judge is the only way out."""
    token, judge = deployed
    me = get_default_account().address

    token.mint(args=[DEPOSIT]).transact()
    token.escrow(args=[judge.address, DEPOSIT]).transact()
    judge.fund_deposit(args=[SLUG]).transact()

    assert tx_execution_succeeded(judge.withdraw_deposit(args=[SLUG]).transact())
    assert token.escrow_of(args=[me, judge.address]).call() == 0
    assert token.available_of(args=[me]).call() == DEPOSIT


@pytest.mark.integration
def test_a_second_judge_cannot_touch_the_first_judge_s_escrow(deployed):
    """`release` is custodian-scoped, and the custodian is whoever the escrow named."""
    token, judge = deployed
    other = get_contract_factory('SlaClaimJudge').deploy(
        args=['https://proxy.invalid', token.address, BOND, BOUNTY]
    )
    me = get_default_account().address

    token.mint(args=[DEPOSIT]).transact()
    token.escrow(args=[judge.address, DEPOSIT]).transact()

    # `other` has no escrow of its own, so its deposit read is empty and its
    # withdrawal has nothing to release — the escrow stays where it was put.
    assert not tx_execution_succeeded(other.fund_deposit(args=[SLUG]).transact())
    assert token.escrow_of(args=[me, judge.address]).call() == DEPOSIT
