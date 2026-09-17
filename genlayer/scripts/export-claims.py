#!/usr/bin/env python
"""
Export every claim the judge holds, as JSON.

Half of publishing `semanticConformance` (issue #92). The other half —
aggregating and writing the ENS record — is `scripts/publish-semantic-scores.mjs`,
in JS, because that is where the ENS writer lives.

Split along the toolchain boundary rather than forced into one language: reading
GenLayer means its own calldata codec, which `genlayer-py` has here and the JS
side would have to carry a browser SDK for; writing ENS means viem and the
key-scoped resolver, which the Python side has no business knowing about.

The seam being a JSON file is a feature, not a workaround. `semanticConformance`
ranks providers publicly, and the exact input a published number came from is
worth being able to look at.

    cd genlayer
    .venv/bin/python scripts/export-claims.py --judge 0x… > /tmp/claims.json
    cd .. && node scripts/publish-semantic-scores.mjs --claims /tmp/claims.json
"""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _networks import NETWORKS, resolve_chain  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--judge', default=os.environ.get('GENLAYER_JUDGE_ADDRESS'))
    parser.add_argument('--network', default=os.environ.get('GENLAYER_NETWORK', 'studio_devnet'), choices=NETWORKS)
    args = parser.parse_args()

    if not args.judge:
        print('no judge address — pass --judge or set GENLAYER_JUDGE_ADDRESS', file=sys.stderr)
        return 2

    import genlayer_py

    # A read still needs an account: genlayer-py signs the `from` of a
    # `gen_call` even when nothing is written. A throwaway key is the honest
    # answer — this reads public state and must never need a funded one.
    from eth_account import Account

    account = Account.from_key(os.environ.get('GENLAYER_PRIVATE_KEY') or ('0x' + '11' * 32))
    client = genlayer_py.create_client(chain=resolve_chain(genlayer_py, args.network), account=account)
    claims = client.read_contract(address=args.judge, function_name='list_claims', args=[])

    # Only what the aggregate needs, and the slug it belongs to. The criteria
    # and the reasoning are on chain for anyone who wants them; a published
    # ratio does not need to carry them around.
    rows = [
        {'slug': claim.get('slug'), 'request_id': claim.get('request_id'),
         'clause_id': claim.get('clause_id'), 'outcome': claim.get('outcome')}
        for claim in (claims if isinstance(claims, list) else [])
    ]
    print(json.dumps({'judge': args.judge, 'network': args.network, 'claims': rows}, indent=2))
    print(f'{len(rows)} claims', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
