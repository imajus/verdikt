"""Shared fixtures and mock helpers for SlaClaimJudge's direct-mode tests.

Direct mode runs the leader function only — `validator_fn` is never exercised
here. Consensus behaviour belongs in integration tests against a real node.
"""

import base64
import datetime
import json
import sys

import pytest

PROXY = 'https://proxy.test'
REQUEST_ID = '0x' + 'ab' * 32
SLUG = 'summarizer'
CLAUSE_ID = 'faithful-summary'
CRITERIA = 'The response must summarise the document supplied in the request, in English, in under 200 words.'
# The payer's consent to disclose its own response body. Not verified by the
# contract — the proxy checks it against the payer Arc booked — so any
# well-formed hex stands in here.
SIGNATURE = '0x' + '11' * 65


PAID_AMOUNT = 2500
BOND = 1000
BOUNTY = 100

ARC_RPC = 'https://arc.test/rpc'
REGISTRY = '0xE182626142E63EF440421cb0c5e4DEbeEF76E4Af'
FILING_WINDOW = 86_400
# Arc's clock, as the mocked `eth_getBlockByNumber` reports it. The verdict
# below is written well inside the filing window of this.
NOW = 1_789_400_000
WRITTEN_AT = NOW - 3600


@pytest.fixture
def judge(direct_deploy):
    """
    A deployed SlaClaimJudge with no settlement token.

    Direct mode cannot make cross-contract calls at all — `gl_call`'s
    `CallContract`/`PostMessage` ops are unhandled without glsim's hook — so a
    judge that talks to a token is untestable here. With `token_address`
    empty it decides claims and settles nothing, which is exactly the half
    direct mode *can* prove. The arithmetic is covered as a pure function in
    test_settlement.py, and the wiring needs a node (#85).

    The Arc eligibility gate is *not* in that category: it is a web call, which
    direct mode mocks, so it is exercised for real below.
    """
    return direct_deploy('contracts/sla_claim_judge.py', PROXY, '', 0, BOUNTY, REGISTRY, ARC_RPC, FILING_WINDOW)


@pytest.fixture
def token(direct_deploy):
    return direct_deploy('contracts/settlement_token.py', 'Verdikt Settlement', 'VSET')


def load_judge_module():
    """
    Import `contracts/sla_claim_judge.py` as a plain module.

    `settlement_for` is pure — the whole point of factoring it out — but it
    lives in a file whose first import is the GenVM SDK, which only lands on
    `sys.path` once something has been deployed. So call this after a fixture
    that deploys, same constraint `to_hex` is written around.
    """
    import importlib.util
    import sys
    from pathlib import Path

    # The SDK allows exactly one `gl.Contract` subclass per process and the
    # deploy above already registered one, so a second import of the same file
    # raises. Park the registration, import, put it back — glsim does the same
    # thing for the same reason.
    registry = sys.modules.get('genlayer.gl.genvm_contracts')
    attr = next((name for name in ('__known_contact__', '__known_contract__') if hasattr(registry, name)), None)
    parked = getattr(registry, attr) if attr else None
    if attr:
        setattr(registry, attr, None)
    try:
        path = Path(__file__).resolve().parents[2] / 'contracts' / 'sla_claim_judge.py'
        spec = importlib.util.spec_from_file_location('sla_claim_judge_under_test', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if attr:
            setattr(registry, attr, parked)


def to_hex(addr_bytes):
    """Checksummed hex matching what the contract's views return."""
    if hasattr(addr_bytes, 'as_hex'):
        return addr_bytes.as_hex
    from genlayer.py.types import Address

    return Address(addr_bytes).as_hex


def sla_document(*, clause_type='semantic', criteria=CRITERIA, clause_id=CLAUSE_ID):
    """A mixed SLA: one deterministic clause and one semantic clause.

    Mixed on purpose — the semantic clause must be findable without the
    deterministic ones getting in the way, which is the case that broke when
    the schema first grew a fourth clause type.
    """
    semantic = {'id': clause_id, 'type': clause_type}
    if clause_type == 'semantic':
        if criteria is not None:
            semantic['criteria'] = criteria
    else:
        semantic['maxMs'] = 5000
    return {
        'version': 1,
        'clauses': [
            {'id': 'is-json', 'type': 'schema', 'schema': {'type': 'object'}},
            semantic,
        ],
    }


def mock_sla(direct_vm, *, slug=SLUG, sla=None, status=200):
    """Register the proxy's `/internal/sla/<slug>` read."""
    body = json.dumps({'sla': json.dumps(sla if sla is not None else sla_document()), 'url': 'https://upstream.test'})
    direct_vm.mock_web(rf'.*/internal/sla/{slug}.*', {'status': status, 'body': body})


def evidence_envelope(
    *,
    status=200,
    content_type='application/json',
    response_body='{"summary": "A short summary of the document."}',
    body_encoding='utf8',
    request_body='{"document": "..."}',
    method='POST',
):
    return {
        'requestId': REQUEST_ID,
        'slug': SLUG,
        'request': {'method': method, 'url': f'https://{SLUG}.verdikt.bond/summarize', 'body': request_body},
        'response': {
            'status': status,
            'contentType': content_type,
            'body': response_body,
            'bodyEncoding': body_encoding,
        },
        'cachedAt': 1789000000,
    }


# A one-pixel PNG. Real bytes rather than a placeholder, because the contract
# base64-decodes the envelope body before handing it to the model.
PNG_PIXEL = base64.b64encode(
    bytes.fromhex(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
        '890000000a49444154789c6360000002000100ffff03000006000557bfabd400'
        '00000049454e44ae426082'
    )
).decode()


def image_envelope(*, content_type='image/png', response_body=PNG_PIXEL, body_encoding='base64'):
    return evidence_envelope(content_type=content_type, response_body=response_body, body_encoding=body_encoding)


def mock_evidence(direct_vm, *, envelope=None, status=200):
    body = json.dumps(envelope if envelope is not None else evidence_envelope())
    direct_vm.mock_web(rf'.*/internal/evidence/.*', {'status': status, 'body': body})


def encode_verdict(*, service_id=None, outcome=0, payer, paid_amount=PAID_AMOUNT, written_at=WRITTEN_AT):
    """The registry's `getVerdict` return: seven static words, encoded in place.

    Shape confirmed against the live registry on Arc Testnet, which answers
    exactly 224 bytes for a real request id and for an unset one alike.
    """
    words = [
        bytes.fromhex((service_id or service_id_hex(SLUG))[2:]),
        (outcome).to_bytes(32, 'big'),
        bytes(12) + bytes.fromhex(payer[2:]),
        (paid_amount).to_bytes(32, 'big'),
        (0).to_bytes(32, 'big'),
        (written_at).to_bytes(32, 'big'),
        bytes(32),
    ]
    return '0x' + b''.join(words).hex()


def service_id_hex(slug):
    """`keccak256(bytes(slug))`, computed outside the contract so the test is
    not checking the contract against itself."""
    from Crypto.Hash import keccak

    digest = keccak.new(digest_bits=256)
    digest.update(slug.encode('utf-8'))
    return '0x' + digest.hexdigest()


ZERO_ADDRESS = '0x' + '00' * 20
ARC_HOST_PATTERN = rf'.*{ARC_RPC.split("//")[1]}.*'


def mock_arc(direct_vm, *, verdict_hex=None, payer=None, now=NOW, status=200, rpc_error=None, body=None, **verdict):
    """Answer the batched eligibility read.

    One POST carrying both questions, so one mock answers both — which is also
    why the contract batches rather than making two calls: the direct VM
    matches on URL and method, and two POSTs to the same endpoint are
    indistinguishable to it.
    """
    if body is None:
        if rpc_error is not None:
            answers = [{'jsonrpc': '2.0', 'id': 1, 'error': {'message': rpc_error}}]
        else:
            answers = [
                {'jsonrpc': '2.0', 'id': 1,
                 'result': verdict_hex or encode_verdict(payer=payer or ZERO_ADDRESS, **verdict)},
                {'jsonrpc': '2.0', 'id': 2, 'result': {'timestamp': hex(now)}},
            ]
        body = json.dumps(answers)
    # Full mock format, because the method matters: the mock matcher keys on
    # URL *and* method, and this is the one POST the contract makes.
    direct_vm.mock_web(
        ARC_HOST_PATTERN,
        {'method': 'POST', 'response': {'status': status, 'headers': {}, 'body': body.encode('utf-8')}},
    )


def mock_judgment(direct_vm, outcome, reasoning='Because.'):
    direct_vm.mock_llm(r'.*adjudicating whether an API response.*', json.dumps({'outcome': outcome, 'reasoning': reasoning}))


def advance(direct_vm, seconds):
    """Move the clock the contract actually reads, forward from where it is now.

    `direct_vm.warp` moves the stdlib clock but not `gl.message_raw['datetime']`,
    which is where the VM puts the transaction timestamp and therefore what the
    contract measures its deadlines against. Both are set, and the step is
    relative to the current message time rather than to wall-clock now, so a
    test that advances the clock cannot leave it somewhere that changes what a
    later test means.
    """
    gl = sys.modules.get('genlayer.gl')
    raw = getattr(gl, 'message_raw', None) if gl is not None else None
    current = (raw or {}).get('datetime') or datetime.datetime.now(datetime.timezone.utc).isoformat()
    when = datetime.datetime.fromisoformat(current.replace('Z', '+00:00')) + datetime.timedelta(seconds=seconds)
    stamp = when.isoformat().replace('+00:00', 'Z')
    direct_vm.warp(stamp)
    if raw is not None:
        raw['datetime'] = stamp
