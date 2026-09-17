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
    .venv/bin/python scripts/deploy.py
    .venv/bin/python scripts/deploy.py --network localnet --dry-run

`studio_devnet` is the default and the Agent Tank submission target, not
`testnet_bradbury` — see `_networks.py` for what that network is and the four
things reaching it requires.
"""

import argparse
import json
import os
import sys
from pathlib import Path

# Not a package import: this makes `_networks` resolve whether the file runs
# as `__main__` or is loaded directly (`test_eligibility.py` does that to
# `claim.py`, and this keeps the same pattern for consistency).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _networks import (  # noqa: E402
    DEPLOY_WAIT_INTERVAL_MS,
    DEPLOY_WAIT_RETRIES,
    NETWORKS,
    deployment_filename,
    resolve_chain,
)

REPO = Path(__file__).resolve().parents[2]
GENLAYER = REPO / 'genlayer'
CONTRACTS = GENLAYER / 'contracts'

# Both in the settlement token's own minor units. The token is pegged to
# nothing, so these are legible round numbers rather than a currency amount:
# the bond a claimant risks, and the bounty for doing the work of resolving.
DEFAULT_BOND = 1_000_000
DEFAULT_BOUNTY = 100_000

# How long after a verdict is written a claim may still be opened. Bounds the
# provider's exposure; the proxy's evidence cache carries the separate
# adjudication clock (docs/roadmap/genlayer.md, "Two clocks, not one").
DEFAULT_FILING_WINDOW_SECONDS = 24 * 60 * 60

# How long a requested withdrawal waits before a deposit may leave. Must be at
# least twice the filing window — the constructor refuses otherwise — because a
# cooldown that does not outlast the exposure is no cooldown at all.
DEFAULT_COOLDOWN_SECONDS = 72 * 60 * 60


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
    parser.add_argument('--network', default='studio_devnet', choices=NETWORKS)
    parser.add_argument('--proxy-base-url', default=None, help='defaults to PROXY_BASE_URL, then the workers.dev host')
    parser.add_argument('--bond', type=int, default=DEFAULT_BOND)
    parser.add_argument('--bounty', type=int, default=DEFAULT_BOUNTY)
    parser.add_argument('--registry', default=None, help='VerdiktRegistry on Arc; defaults to deployments/arc-testnet.json')
    parser.add_argument('--arc-rpc-url', default=None, help='defaults to ARC_RPC_URL')
    parser.add_argument('--filing-window', type=int, default=DEFAULT_FILING_WINDOW_SECONDS)
    parser.add_argument('--cooldown', type=int, default=DEFAULT_COOLDOWN_SECONDS)
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

    chain = resolve_chain(genlayer_py, args.network)
    account = Account.from_key(private_key)
    client = genlayer_py.create_client(chain=chain, account=account)

    # Straight through the provider: genlayer-py's client surface is
    # contracts and transactions, and has no balance helper.
    balance = int(client.provider.make_request(method='eth_getBalance', params=[account.address, 'latest'])['result'], 16)
    print(f'network  {args.network} (chain {chain.id})')
    print(f'account  {account.address}')
    print(f'balance  {balance}')
    # Only a public testnet, or Studio Dev's own simulator balance, actually
    # charges. A local sim reports zero for every account and deploys happily,
    # so refusing there would block the one network that needs no faucet.
    if balance == 0 and (args.network.startswith('testnet_') or args.network == 'studio_devnet'):
        # Deploying from an empty account fails somewhere further in, with a
        # message about the transaction rather than about the money. Say the
        # useful thing here instead.
        if args.network == 'studio_devnet':
            print(
                f'\nThis account has no GEN. Fund it with `sim_fundAccount` against {chain.rpc_urls["default"]["http"][0]} '
                '— Studio Dev is a hosted simulator, not a faucet-gated testnet.',
                file=sys.stderr,
            )
        else:
            print('\nThis account has no GEN. Claim some at https://testnet-faucet.genlayer.foundation/', file=sys.stderr)
        if not args.dry_run:
            return 3

    # The apex host, nothing more: the judge appends `/internal/sla/<slug>`
    # and `/internal/evidence/<id>` itself. `genlayer/.env.example` says which
    # value this is and which it is not.
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
        print(
            f'                 registry={registry} arc_rpc={arc_rpc_url} '
            f'filing_window={args.filing_window}s cooldown={args.cooldown}s'
        )
        return 0

    # The fee distribution has to be passed explicitly. Left to itself the
    # client encodes an all-zero one and consensus rejects the transaction as
    # `FeesDistributionMissing` — which surfaces as a bare "reverted" with no
    # reason, and looks for all the world like a broken contract rather than a
    # missing argument (genlayer-cli#421). Asking the chain for its own numbers
    # is also the only way to get ones it will accept.
    fees = {'distribution': client.estimate_fees_distribution()}

    token_code = (CONTRACTS / 'settlement_token.py').read_text()
    print('\ndeploying SettlementToken…')
    token_address = client.deploy_contract(
        code=token_code, args=[args.token_name, args.token_symbol], fees=fees
    )
    token_address = _address_of(client, token_address)
    print(f'  {token_address}')

    judge_code = (CONTRACTS / 'sla_claim_judge.py').read_text()
    print('deploying SlaClaimJudge…')
    judge_address = client.deploy_contract(
        code=judge_code,
        args=[
            proxy_base_url, token_address, args.bond, args.bounty,
            registry, arc_rpc_url, args.filing_window, args.cooldown,
        ],
        fees=fees,
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
        'cooldownSeconds': args.cooldown,
    }
    out = REPO / 'deployments' / deployment_filename(args.network)
    out.write_text(json.dumps(record, indent=2) + '\n')
    print(f'\nwrote {out.relative_to(REPO)}')
    return 0


def _address_of(client, deployed) -> str:
    """
    `deploy_contract` returns a transaction hash on some paths and an address
    on others. Resolve it, and refuse anything that only *looks* deployed.

    Two distinct non-deployments both hand back an address here, which is the
    whole reason this checks rather than returns:

    - Consensus decides `accepted` while the leader's `execution_result` is
      `ERROR`. The validators agreed — that the execution failed. An address
      is minted regardless and every later call answers "not found".
    - Consensus has not decided yet. studio_devnet routinely takes minutes and
      the client's default is 30 seconds, so the honest answer there is to
      wait longer, not to treat a pending transaction as a failed one.
    """
    if isinstance(deployed, str) and len(deployed) == 42:
        return deployed
    receipt = client.wait_for_transaction_receipt(
        transaction_hash=deployed,
        interval=DEPLOY_WAIT_INTERVAL_MS,
        retries=DEPLOY_WAIT_RETRIES,
    )
    leader = (receipt.get('consensus_data') or {}).get('leader_receipt') or [{}]
    result = leader[0].get('execution_result')
    if result != 'SUCCESS':
        detail = (leader[0].get('genvm_result') or {}).get('stderr', '') or result
        raise SystemExit(f'deployment did not execute: {detail}')
    address = receipt.get('data', {}).get('contract_address') or receipt.get('contract_address')
    if not address:
        raise SystemExit(f'no contract address in receipt: {receipt}')
    return address


if __name__ == '__main__':
    raise SystemExit(main())
