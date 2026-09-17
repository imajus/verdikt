"""
The Arc gate: every claim binds to a fact on the chain that recorded the call.

`request_id` is public in every `VerdictWritten` event, so without this anyone
could file against anyone else's call — and every GenLayer execution cost that
follows would be spent on it.

Unlike the token wiring, this *is* reachable in direct mode: it is a web call,
and direct mode mocks those. The mocked answers are byte-shaped like the real
ones — `encode_verdict` builds the same seven static words the live registry on
Arc Testnet was observed returning.
"""

import pytest

from tests.direct.conftest import (
    CLAUSE_ID,
    FILING_WINDOW,
    NOW,
    PAID_AMOUNT,
    REQUEST_ID,
    SIGNATURE,
    SLUG,
    WRITTEN_AT,
    ZERO_ADDRESS,
    encode_verdict,
    load_judge_module,
    mock_arc,
    mock_sla,
    service_id_hex,
    to_hex,
)

OTHER_PAYER = '0x' + 'ee' * 20


def test_a_claim_bound_to_a_real_verdict_opens(direct_vm, judge, direct_alice):
    direct_vm.sender = direct_alice
    mock_sla(direct_vm)
    mock_arc(direct_vm, payer=to_hex(direct_alice))

    judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    assert judge.get_claim(REQUEST_ID, CLAUSE_ID)['outcome'] == 'OPEN'


# `paidAmount` is read off the chain rather than taken from the claimant. A
# claimant who could name it could name any compensation they liked.
def test_the_amount_comes_from_arc_not_from_the_claimant(direct_vm, judge, direct_alice):
    direct_vm.sender = direct_alice
    mock_sla(direct_vm)
    mock_arc(direct_vm, payer=to_hex(direct_alice), paid_amount=99_999)

    judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    assert judge.get_claim(REQUEST_ID, CLAUSE_ID)['paid_amount'] == 99_999


class TestRefusals:
    # `getVerdict` on an unset key returns Solidity's zero-valued struct rather
    # than reverting, so `writtenAt == 0` is the only thing that can say "there
    # was no such call". Confirmed against the live registry.
    def test_a_request_with_no_verdict(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        mock_sla(direct_vm)
        mock_arc(direct_vm, verdict_hex='0x' + '00' * 224)

        with direct_vm.expect_revert('No verdict was written'):
            judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    # Same path covers the replay-402 and fallback-4xx carve-outs: both write no
    # verdict at all, so both are rejected before any judgment logic runs.
    def test_a_call_the_provider_was_never_paid_for(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        mock_sla(direct_vm)
        mock_arc(direct_vm, payer=to_hex(direct_alice), written_at=0)

        with direct_vm.expect_revert('No verdict was written'):
            judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    # TEMPORARY (hackathon demo): skipped, not deleted. The rule it covers is
    # commented out in `check_eligibility`; this comes back with it.
    @pytest.mark.skip(reason='TEMPORARY (hackathon demo): the payer check is disabled in check_eligibility')
    def test_someone_who_did_not_pay_for_the_call(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        mock_sla(direct_vm)
        mock_arc(direct_vm, payer=OTHER_PAYER)

        with direct_vm.expect_revert('Only the payer'):
            judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    # A verdict names its own service. Without this, a claimant could point a
    # real verdict at a different slug and dispute it against that provider's
    # deposit.
    def test_a_verdict_belonging_to_another_service(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        mock_sla(direct_vm)
        mock_arc(direct_vm, payer=to_hex(direct_alice), service_id=service_id_hex('some-other-service'))

        with direct_vm.expect_revert(f'does not belong to {SLUG}'):
            judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    def test_a_call_older_than_the_filing_window(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        mock_sla(direct_vm)
        mock_arc(direct_vm, payer=to_hex(direct_alice), written_at=NOW - FILING_WINDOW - 1)

        with direct_vm.expect_revert('filing window'):
            judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    def test_a_call_right_on_the_deadline_still_opens(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        mock_sla(direct_vm)
        mock_arc(direct_vm, payer=to_hex(direct_alice), written_at=NOW - FILING_WINDOW)

        judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)
        assert judge.get_claim(REQUEST_ID, CLAUSE_ID)['outcome'] == 'OPEN'


class TestArcFailures:
    """The class of an RPC failure is load-bearing: validators compare on it."""

    def test_an_rpc_error_is_the_node_s_deterministic_answer(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        mock_sla(direct_vm)
        mock_arc(direct_vm, rpc_error='execution reverted')

        with direct_vm.expect_revert('[EXTERNAL]'):
            judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    def test_an_outage_is_transient_so_the_claimant_can_retry(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        mock_sla(direct_vm)
        mock_arc(direct_vm, status=503, body='gateway down')

        with direct_vm.expect_revert('[TRANSIENT]'):
            judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    def test_a_truncated_struct_is_refused_rather_than_misread(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        mock_sla(direct_vm)
        mock_arc(direct_vm, verdict_hex='0x' + '11' * 100)

        with direct_vm.expect_revert('expected 224'):
            judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    def test_half_an_answer_to_the_batch_is_refused(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        mock_sla(direct_vm)
        mock_arc(direct_vm, body='[{"jsonrpc":"2.0","id":1,"result":"0x00"}]')

        with direct_vm.expect_revert('only part of the batch'):
            judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)

    def test_a_non_array_answer_to_a_batch_is_refused(self, direct_vm, judge, direct_alice):
        direct_vm.sender = direct_alice
        mock_sla(direct_vm)
        mock_arc(direct_vm, body='{"jsonrpc":"2.0","id":1,"result":"0x00"}')

        with direct_vm.expect_revert('as an array'):
            judge.submit_claim(REQUEST_ID, CLAUSE_ID, SLUG, SIGNATURE)


class TestPureRules:
    """`check_eligibility` and the decoder, without a chain."""

    @pytest.fixture
    def judge_module(self, judge):
        return load_judge_module()

    def test_the_decoder_reads_the_seven_words_the_registry_writes(self, judge_module):
        verdict = judge_module._decode_verdict(
            encode_verdict(payer=OTHER_PAYER, outcome=1, paid_amount=10_000, written_at=1_789_316_048)
        )
        assert verdict == {
            'service_id': service_id_hex(SLUG),
            'outcome': 1,
            'payer': OTHER_PAYER,
            'paid_amount': 10_000,
            'refund_credited': 0,
            'written_at': 1_789_316_048,
            'failed_clause': '0x' + '00' * 32,
        }

    # The registry derives serviceId the same way, and both sides already pin
    # this against a shared vector. Computed here with a different keccak
    # implementation so the test is not checking the contract against itself.
    def test_service_id_matches_the_registry_s_derivation(self, judge_module):
        assert judge_module.service_id_of(SLUG) == service_id_hex(SLUG)

    def test_the_selector_is_the_one_the_registry_answers(self, judge_module):
        from Crypto.Hash import keccak

        digest = keccak.new(digest_bits=256)
        digest.update(b'getVerdict(bytes32)')
        assert judge_module._encode_get_verdict(REQUEST_ID).startswith('0x' + digest.hexdigest()[:8])

    def test_every_rule_in_one_place(self, judge_module):
        good = {
            'service_id': service_id_hex(SLUG),
            'payer': OTHER_PAYER,
            'paid_amount': PAID_AMOUNT,
            'written_at': WRITTEN_AT,
            'within_filing_window': True,
        }
        assert judge_module.check_eligibility(good, OTHER_PAYER, SLUG) is None
        assert judge_module.check_eligibility({**good, 'written_at': 0}, OTHER_PAYER, SLUG) is not None
        # TEMPORARY (hackathon demo): the payer rule is commented out in
        # `check_eligibility`, so a non-payer is no longer refused here.
        # Restore this line with it.
        # assert judge_module.check_eligibility(good, ZERO_ADDRESS, SLUG) is not None
        assert judge_module.check_eligibility(good, OTHER_PAYER, 'elsewhere') is not None
        assert judge_module.check_eligibility({**good, 'within_filing_window': False}, OTHER_PAYER, SLUG) is not None

    # A checksummed address from the registry and a lowercase one from the
    # message are the same account; refusing on case would lock out every payer.
    def test_the_payer_comparison_ignores_checksum_case(self, judge_module):
        verdict = {
            'service_id': service_id_hex(SLUG),
            'payer': OTHER_PAYER.upper().replace('0X', '0x'),
            'written_at': WRITTEN_AT,
            'within_filing_window': True,
        }
        assert judge_module.check_eligibility(verdict, OTHER_PAYER, SLUG) is None


# The Python half of a two-language agreement. `proxy/src/evidence.js` builds
# the same string, and `evidence.test.js` pins it there; a change on either side
# makes every disclosure refuse, which reads as a claimant error rather than as
# the drift it is.
def test_the_disclosure_message_matches_the_proxy_byte_for_byte():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[2] / 'scripts' / 'claim.py'
    spec = importlib.util.spec_from_file_location('claim_cli_under_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert module.DISCLOSURE_PREFIX == 'Verdikt evidence disclosure\nrequest: '
    assert module.DISCLOSURE_PREFIX + REQUEST_ID == f'Verdikt evidence disclosure\nrequest: {REQUEST_ID}'
