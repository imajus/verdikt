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


@pytest.fixture
def judge(direct_deploy):
    """A deployed SlaClaimJudge pointed at the fake proxy host."""
    return direct_deploy('contracts/sla_claim_judge.py', PROXY)


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
