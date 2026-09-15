#!/usr/bin/env python
"""
Deploy SettlementToken and SlaClaimJudge, then read the result back off chain.

Order matters and is not negotiable: the judge takes the token's address in its
constructor, so the token goes first.

The read-back at the end is the point of this script, not a flourish. This
codebase has already been bitten once by a transaction that mined and did
nothing — the KeystoneForwarder swallows a receiver revert and reports success
(CLAUDE.md, "Two silent failures") — and a deployment is not finished when the
call returns, it is finished when the contract answers.

    cd genlayer
    .venv/bin/python scripts/deploy.py --network testnet_bradbury
    .venv/bin/python scripts/deploy.py --network localnet --dry-run
"""

import argparse
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GENLAYER = REPO / 'genlayer'
CONTRACTS = GENLAYER / 'contracts'

# The name genlayer-py knows each network by; the RPC comes from its own chain
# registry, so a free-form label here would resolve to nothing.
NETWORKS = ('localnet', 'studionet', 'testnet_asimov', 'testnet_bradbury')

# Both in the settlement token's own minor units. The token is pegged to
# nothing, so these are legible round numbers rather than a currency amount:
# the bond a claimant risks, and the bounty for doing the work of resolving.
DEFAULT_BOND = 1_000_000
DEFAULT_BOUNTY = 100_000

# How long after a verdict is written a claim may still be opened. Bounds the
# provider's exposure; the proxy's evidence cache carries the separate
# adjudication clock (docs/roadmap/genlayer.md, "Two clocks, not one").
DEFAULT_FILING_WINDOW_SECONDS = 24 * 60 * 60


def load_env() -> dict:
    """Read the repo's `.env` without adding a dependency to do it."""
    values = dict(os.environ)
    for path in (REPO / '.env', GENLAYER / '.env'):
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            value = value.strip()
            if value:
                values.setdefault(key.strip(), value)
    return values


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--network', default='testnet_bradbury', choices=NETWORKS)
    parser.add_argument('--proxy-base-url', default=None, help='defaults to PROXY_BASE_URL, then the workers.dev host')
    parser.add_argument('--bond', type=int, default=DEFAULT_BOND)
    parser.add_argument('--bounty', type=int, default=DEFAULT_BOUNTY)
    parser.add_argument('--registry', default=None, help='VerdiktRegistry on Arc; defaults to deployments/arc-testnet.json')
    parser.add_argument('--arc-rpc-url', default=None, help='defaults to ARC_RPC_URL')
    parser.add_argument('--filing-window', type=int, default=DEFAULT_FILING_WINDOW_SECONDS)
    parser.add_argument('--token-name', default='Verdikt Settlement')
    parser.add_argument('--token-symbol', default='VSET')
    parser.add_argument('--dry-run', action='store_true', help='check the account and balance, deploy nothing')
    args = parser.parse_args()

    import genlayer_py
    from eth_account import Account

    env = load_env()
    private_key = env.get('GENLAYER_PRIVATE_KEY')
    if not private_key:
        print('GENLAYER_PRIVATE_KEY is unset. See genlayer/README.md — it is a plain', file=sys.stderr)
        print('secp256k1 key, and the account behind it needs testnet GEN to deploy.', file=sys.stderr)
        return 2

    chain = getattr(genlayer_py, args.network)
    account = Account.from_key(private_key)
    client = genlayer_py.create_client(chain=chain, account=account)

    # Straight through the provider: genlayer-py's client surface is
    # contracts and transactions, and has no balance helper.
    balance = int(client.provider.make_request(method='eth_getBalance', params=[account.address, 'latest'])['result'], 16)
    print(f'network  {args.network} (chain {chain.id})')
    print(f'account  {account.address}')
    print(f'balance  {balance}')
    # Only a public testnet actually charges. A local sim reports zero for
    # every account and deploys happily, so refusing there would block the one
    # network that needs no faucet.
    if balance == 0 and args.network.startswith('testnet_'):
        # Deploying from an empty account fails somewhere further in, with a
        # message about the transaction rather than about the money. Say the
        # useful thing here instead.
        print('\nThis account has no GEN. Claim some at https://testnet-faucet.genlayer.foundation/', file=sys.stderr)
        if not args.dry_run:
            return 3

    proxy_base_url = (
        args.proxy_base_url or env.get('PROXY_BASE_URL') or 'https://verdikt-proxy.denis-perov.workers.dev'
    )
    arc = json.loads((REPO / 'deployments' / 'arc-testnet.json').read_text())
    registry = args.registry or env.get('VERDIKT_REGISTRY_ADDRESS') or arc['registry']
    arc_rpc_url = args.arc_rpc_url or env.get('ARC_RPC_URL')
    if not arc_rpc_url:
        # The eligibility gate reads Arc on every claim. Without an RPC the
        # judge deploys and then refuses every claim it is given, which looks
        # like a bug rather than a missing setting.
        print('ARC_RPC_URL is unset — the judge could not read a verdict.', file=sys.stderr)
        return 2

    if args.dry_run:
        print(f'\nwould deploy with proxy_base_url={proxy_base_url} bond={args.bond} bounty={args.bounty}')
        print(f'                 registry={registry} arc_rpc={arc_rpc_url} filing_window={args.filing_window}s')
        return 0

    token_code = (CONTRACTS / 'settlement_token.py').read_text()
    print('\ndeploying SettlementToken…')
    token_address = client.deploy_contract(code=token_code, args=[args.token_name, args.token_symbol])
    token_address = _address_of(client, token_address)
    print(f'  {token_address}')

    judge_code = (CONTRACTS / 'sla_claim_judge.py').read_text()
    print('deploying SlaClaimJudge…')
    judge_address = client.deploy_contract(
        code=judge_code,
        args=[proxy_base_url, token_address, args.bond, args.bounty, registry, arc_rpc_url, args.filing_window],
    )
    judge_address = _address_of(client, judge_address)
    print(f'  {judge_address}')

    # Read back, always. A deployment that returned an address and cannot answer
    # a view is not a deployment, and this is exactly the failure mode this repo
    # learned to check for the hard way.
    print('\nreading back…')
    info = client.read_contract(address=token_address, function_name='get_info')
    config = client.read_contract(address=judge_address, function_name='get_config')
    print(f'  token  {info}')
    print(f'  judge  {config}')
    if config.get('token_address') != token_address:
        print('\nThe judge does not point at the token that was just deployed.', file=sys.stderr)
        return 4

    record = {
        '$comment': (
            "Verdikt's GenLayer deployment. Checked in for the same reason the Arc and "
            'Sepolia ones are: the addresses are public and every reader needs them.'
        ),
        'network': args.network,
        'chainId': chain.id,
        'settlementToken': token_address,
        'slaClaimJudge': judge_address,
        'proxyBaseUrl': proxy_base_url,
        'bondAmount': args.bond,
        'bountyAmount': args.bounty,
        'registryAddress': registry,
        'filingWindowSeconds': args.filing_window,
    }
    out = REPO / 'deployments' / f'genlayer-{args.network.replace("testnet_", "")}.json'
    out.write_text(json.dumps(record, indent=2) + '\n')
    print(f'\nwrote {out.relative_to(REPO)}')
    return 0


def _address_of(client, deployed) -> str:
    """`deploy_contract` returns a transaction hash on some paths and an address on others."""
    if isinstance(deployed, str) and len(deployed) == 42:
        return deployed
    receipt = client.wait_for_transaction_receipt(transaction_hash=deployed)
    address = receipt.get('data', {}).get('contract_address') or receipt.get('contract_address')
    if not address:
        raise SystemExit(f'no contract address in receipt: {receipt}')
    return address


if __name__ == '__main__':
    raise SystemExit(main())
