"""Shared fixtures and mock helpers for SlaClaimJudge's direct-mode tests.

Direct mode runs the leader function only — `validator_fn` is never exercised
here. Consensus behaviour belongs in integration tests against a real node.
"""

import json

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
            'bodyEncoding': 'utf8',
        },
        'cachedAt': 1789000000,
    }


def mock_evidence(direct_vm, *, envelope=None, status=200):
    body = json.dumps(envelope if envelope is not None else evidence_envelope())
    direct_vm.mock_web(rf'.*/internal/evidence/.*', {'status': status, 'body': body})


def mock_judgment(direct_vm, outcome, reasoning='Because.'):
    direct_vm.mock_llm(r'.*adjudicating whether an API response.*', json.dumps({'outcome': outcome, 'reasoning': reasoning}))
