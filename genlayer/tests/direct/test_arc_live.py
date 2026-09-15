"""
The Arc reader, against the live registry. Opt-in: `VERDIKT_LIVE_ARC=1`.

`SlaClaimJudge` decodes `getVerdict` by hand — no ABI library, because GenVM
has none that reaches an arbitrary chain — and hand-rolled decoding is exactly
the kind of code that looks right and is wrong by one word. So this runs the
contract's own encoder and decoder against Arc Testnet.

Off by default because it needs the public internet and a real deployment, and
a suite that goes red when Alchemy has a bad minute is a suite people learn to
ignore. The mocked equivalents in test_eligibility.py run every time; this is
what says the mocks are shaped like the real thing.
"""

import json
import os
import urllib.request
from pathlib import Path

import pytest

from tests.direct.conftest import load_judge_module

# A real PASS verdict on Arc Testnet: the `prices` service, paid by
# 0xF3E1C748…, 10000 USDC minor units.
SETTLED_REQUEST_ID = '0x8c81c0523b17edae2596f4183bfa05c91ce650e5f92817f2eedb29de54ac46b5'
SETTLED_PAYER = '0xf3e1c74828136e1da8cd82ceadfc9d1eea2d1377'
UNSET_REQUEST_ID = '0x' + '00' * 32
REPO = Path(__file__).resolve().parents[3]

pytestmark = pytest.mark.skipif(
    os.environ.get('VERDIKT_LIVE_ARC') != '1', reason='set VERDIKT_LIVE_ARC=1 to read the live registry'
)


def arc_rpc_url():
    if os.environ.get('ARC_RPC_URL'):
        return os.environ['ARC_RPC_URL']
    for line in (REPO / '.env').read_text().splitlines():
        if line.startswith('ARC_RPC_URL='):
            return line.split('=', 1)[1].strip()
    pytest.skip('ARC_RPC_URL is unset')


def eth_call(to, data):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_call', 'params': [{'to': to, 'data': data}, 'latest']})
    # A User-Agent is not optional: Arc's RPC answers 403 to Python's default
    # one, which reads as "the chain is down" if you do not know to look.
    request = urllib.request.Request(
        arc_rpc_url(), data=body.encode(), headers={'Content-Type': 'application/json', 'User-Agent': 'verdikt/1.0'}
    )
    answer = json.loads(urllib.request.urlopen(request, timeout=30).read())
    assert 'error' not in answer, answer['error']
    return answer['result']


@pytest.fixture
def registry():
    return json.loads((REPO / 'deployments' / 'arc-testnet.json').read_text())['registry']


@pytest.fixture
def judge_module(judge):
    return load_judge_module()


def test_the_decoder_reads_a_settled_verdict(judge_module, registry):
    raw = eth_call(registry, judge_module._encode_get_verdict(SETTLED_REQUEST_ID))
    verdict = judge_module._decode_verdict(raw)

    assert len(raw) // 2 - 1 == 224, 'seven static words, encoded in place'
    assert verdict['payer'].lower() == SETTLED_PAYER
    assert verdict['paid_amount'] == 10_000
    assert verdict['written_at'] > 0
    assert verdict['service_id'] == judge_module.service_id_of('prices')


# The registry returns Solidity's zero-valued struct for an unset key rather
# than reverting, so `writtenAt == 0` is the only thing that can say "there was
# no such call". The whole eligibility gate turns on that being true.
def test_an_unset_key_returns_a_zero_struct_rather_than_reverting(judge_module, registry):
    raw = eth_call(registry, judge_module._encode_get_verdict(UNSET_REQUEST_ID))
    verdict = judge_module._decode_verdict(raw)

    assert len(raw) // 2 - 1 == 224
    assert verdict['written_at'] == 0
    assert verdict['payer'] == '0x' + '00' * 20
