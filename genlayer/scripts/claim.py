#!/usr/bin/env python
# Raw, because the shell transcript below ends a line with a backslash: `\ ` is
# not a valid escape and Python already warns that it will stop being ignored.
r"""
The claimant's CLI: file a semantic claim and see it through (issue #94).

A CLI rather than a web UI. The audience is an agent operator who already has a
key and a request id, not a visitor.

Every subcommand that moves money **reads the balance back afterwards**. A
transaction that mined is not a transaction that did anything — this codebase
learned that from a forwarder that swallowed a receiver revert and reported
success, and GenLayer has its own version: consensus can record an ERROR while
the transaction itself looks fine from the outside.

    cd genlayer
    export GENLAYER_PRIVATE_KEY=0x…          # the claimant; must be the payer Arc booked

    .venv/bin/python scripts/claim.py sign --request-id 0x…      # payer consent
    .venv/bin/python scripts/claim.py mint --amount 5000000      # faucet
    .venv/bin/python scripts/claim.py bond                       # escrow the bond
    .venv/bin/python scripts/claim.py open --request-id 0x… --clause faithful --slug summarizer
    GENLAYER_RESOLVER_PRIVATE_KEY=0x… \                       # a distinct account — see `resolve`
        .venv/bin/python scripts/claim.py resolve --request-id 0x… --clause faithful
    .venv/bin/python scripts/claim.py status  --request-id 0x… --clause faithful
    .venv/bin/python scripts/claim.py balance

`sign` is the one that is easy to skip and impossible to work around: the proxy
discloses evidence only to the payer, so a claim opened without the payer's
signature resolves UNDETERMINED for want of anything to judge.
"""

import argparse
import json
import os
import sys
from pathlib import Path

# Not a package import: `test_eligibility.py` loads this file directly via
# `importlib.util.spec_from_file_location`, which never puts `scripts/` on
# `sys.path` the way running this file as `__main__` does.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _networks import (  # noqa: E402
    DEPLOY_WAIT_INTERVAL_MS,
    DEPLOY_WAIT_RETRIES,
    NETWORKS,
    load_deployment,
    resolve_chain,
)

# Mirrors `disclosureMessage` in proxy/src/evidence.js. The two must match
# byte for byte or every disclosure is refused, which reads as a claimant error.
DISCLOSURE_PREFIX = 'Verdikt evidence disclosure\nrequest: '


def connect(args, key=None):
    import genlayer_py
    from eth_account import Account

    key = key or os.environ.get('GENLAYER_PRIVATE_KEY')
    if not key:
        raise SystemExit('GENLAYER_PRIVATE_KEY is unset — that key is the claimant')
    account = Account.from_key(key)
    client = genlayer_py.create_client(chain=resolve_chain(genlayer_py, args.network), account=account)
    return client, account


def addresses(args):
    """The judge and token to act on.

    `deployments/genlayer-<network>.json` is the source of truth; the flag and
    the env var are overrides for a fork or a second deployment, not the normal
    path. Same precedence, and same reasoning, as `VERDIKT_REGISTRY_ADDRESS`
    against `deployments/arc-testnet.json` on the Arc side.
    """
    record = load_deployment(args.network)
    judge = args.judge or os.environ.get('GENLAYER_JUDGE_ADDRESS') or record.get('slaClaimJudge')
    token = args.token or os.environ.get('GENLAYER_TOKEN_ADDRESS') or record.get('settlementToken')
    if not judge:
        raise SystemExit('no judge address — pass --judge, set GENLAYER_JUDGE_ADDRESS, or deploy first')
    return judge, token


def write(client, address, function_name, fn_args):
    """Send a write and report what consensus actually decided.

    `wait_for_transaction_receipt` returning is not success: the leader receipt
    carries its own `execution_result`, and an ERROR there means the call
    reverted inside the VM while the transaction around it is perfectly fine.
    """
    tx = client.write_contract(
        address=address,
        function_name=function_name,
        args=fn_args,
        # Same reason the deploy passes one: without an explicit distribution
        # the client encodes an all-zero one and consensus rejects the write as
        # `FeesDistributionMissing`, reported as a bare revert (_networks.py).
        fees={'distribution': client.estimate_fees_distribution()},
    )
    receipt = client.wait_for_transaction_receipt(
        transaction_hash=tx,
        interval=DEPLOY_WAIT_INTERVAL_MS,
        retries=DEPLOY_WAIT_RETRIES,
    )
    leader = (receipt.get('consensus_data') or {}).get('leader_receipt') or [{}]
    result = leader[0].get('execution_result')
    if result != 'SUCCESS':
        detail = (leader[0].get('genvm_result') or {}).get('stderr', '') or result
        raise SystemExit(f'{function_name} failed: {detail}')
    return receipt


def show_balance(client, token, address, label):
    if not token:
        print(f'  {label}: (no token configured)')
        return None
    balance = client.read_contract(address=token, function_name='balance_of', args=[address])
    available = client.read_contract(address=token, function_name='available_of', args=[address])
    print(f'  {label}: {balance} held, {available} free')
    return balance


# ------------------------------------------------------------------- commands


def cmd_sign(args):
    """The payer's consent to disclose its own purchased response.

    Signed with the *payer's* key, which is normally the claimant's — the judge
    refuses a claim from anyone else, and the proxy refuses a disclosure signed
    by anyone else, so the two checks agree by construction.
    """
    from eth_account import Account
    from eth_account.messages import encode_defunct

    key = os.environ.get('GENLAYER_PRIVATE_KEY')
    if not key:
        raise SystemExit('set GENLAYER_PRIVATE_KEY to the account that paid')
    account = Account.from_key(key)
    message = DISCLOSURE_PREFIX + args.request_id.lower()
    signature = account.sign_message(encode_defunct(text=message)).signature.hex()
    signature = signature if signature.startswith('0x') else '0x' + signature
    print(f'payer     {account.address}')
    print(f'message   {message!r}')
    print(f'signature {signature}')
    return 0


def cmd_mint(args):
    client, account = connect(args)
    _, token = addresses(args)
    if not token:
        raise SystemExit('no token address — pass --token or set GENLAYER_TOKEN_ADDRESS')
    print(f'minting {args.amount} to {account.address}')
    show_balance(client, token, account.address, 'before')
    write(client, token, 'mint', [args.amount])
    show_balance(client, token, account.address, 'after ')
    return 0


def cmd_bond(args):
    """Hand the judge authority over the bond. The tokens do not move."""
    client, account = connect(args)
    judge, token = addresses(args)
    if not token:
        raise SystemExit('no token address — pass --token or set GENLAYER_TOKEN_ADDRESS')
    amount = args.amount or client.read_contract(address=judge, function_name='get_config', args=[])['bond_amount']
    print(f'escrowing {amount} to {judge}')
    write(client, token, 'escrow', [judge, amount])
    escrowed = client.read_contract(address=token, function_name='escrow_of', args=[account.address, judge])
    print(f'  escrowed: {escrowed}')
    show_balance(client, token, account.address, 'balance')
    return 0


def cmd_deposit(args):
    """Provider side: bind an escrow to a slug, so a BREACH has something to pay from."""
    client, _ = connect(args)
    judge, _ = addresses(args)
    write(client, judge, 'fund_deposit', [args.slug])
    print(json.dumps(client.read_contract(address=judge, function_name='get_deposit', args=[args.slug]), indent=2))
    return 0


def cmd_open(args):
    client, _ = connect(args)
    judge, _ = addresses(args)
    if not args.signature:
        raise SystemExit('no --signature — run `claim.py sign --request-id …` first; without it evidence stays sealed')
    write(client, judge, 'submit_claim', [args.request_id, args.clause, args.slug, args.signature])
    return cmd_status(args, client, judge)


def cmd_resolve(args):
    """Have the claim judged.

    `resolve_claim` is permissionless by design — whoever calls it earns the
    bounty — but the bounty is what makes a MET outcome cost the claimant
    anything: `_settle` releases it from the claimant's own bond to the
    resolver. Resolve with the claimant's own key and that release is
    `release(claimant, claimant, amount)`, a debit and credit to the same
    balance, so the documented demo would show a MET outcome that costs the
    claimant nothing. `GENLAYER_RESOLVER_PRIVATE_KEY` picks a distinct
    resolver account for this call; without it, resolving as the claimant is
    still allowed (a real user with no bounty hunter on hand may have no
    choice) but flagged.
    """
    resolver_key = os.environ.get('GENLAYER_RESOLVER_PRIVATE_KEY')
    client, account = connect(args, key=resolver_key)
    judge, token = addresses(args)
    claim = client.read_contract(address=judge, function_name='get_claim', args=[args.request_id, args.clause])
    claimant = claim['claimant']
    self_resolved = account.address.lower() == claimant.lower()
    if self_resolved:
        print(
            'warning: resolving as the claimant — on MET the bounty is released from the '
            "claimant's own bond back to itself, so the deterrent this demo is supposed to "
            'show does not apply. Set GENLAYER_RESOLVER_PRIVATE_KEY to a distinct account to '
            'see it.'
        )
    print('before:')
    show_balance(client, token, claimant, 'claimant')
    if not self_resolved:
        show_balance(client, token, account.address, 'resolver')
    write(client, judge, 'resolve_claim', [args.request_id, args.clause])
    claim = client.read_contract(address=judge, function_name='get_claim', args=[args.request_id, args.clause])
    print(f'\noutcome   {claim["outcome"]}')
    print(f'reasoning {claim["reasoning"]}')
    print(f'paid for  {claim["paid_amount"]}')
    print(f'compensation {claim["compensation"]}  bounty {claim["bounty"]}')
    # The settlement is emitted `on='finalized'`, so the balance moves when the
    # parent transaction finalizes rather than now. Printing it here anyway is
    # the point: a reader sees the judgment and the money as two separate
    # events, which is what they are.
    print('\nafter (settlement lands on finalization):')
    show_balance(client, token, claimant, 'claimant')
    if not self_resolved:
        show_balance(client, token, account.address, 'resolver')
    return 0


def cmd_cancel(args):
    client, _ = connect(args)
    judge, _ = addresses(args)
    write(client, judge, 'cancel_claim', [args.request_id, args.clause])
    return cmd_status(args, client, judge)


def cmd_status(args, client=None, judge=None):
    """Read a claim back. Reuses the caller's client when it already has one —
    `open` and `cancel` both end here, and reconnecting would re-sign a fresh
    account for a read they are already authenticated for."""
    if client is None:
        client, _ = connect(args)
    if judge is None:
        judge, _ = addresses(args)
    claim = client.read_contract(address=judge, function_name='get_claim', args=[args.request_id, args.clause])
    print(json.dumps(claim, indent=2, default=str))
    return 0


def cmd_balance(args):
    client, account = connect(args)
    judge, token = addresses(args)
    print(f'account {account.address}')
    show_balance(client, token, account.address, 'balance')
    if token:
        escrowed = client.read_contract(address=token, function_name='escrow_of', args=[account.address, judge])
        print(f'  escrowed to the judge: {escrowed}')
    bonded = client.read_contract(address=judge, function_name='get_bonded', args=[account.address])
    print(f'  committed to open claims: {bonded}')
    return 0


def cmd_withdraw(args):
    """Provider side: the two-step release. Step one starts a cooldown."""
    client, account = connect(args)
    judge, token = addresses(args)
    if args.request:
        write(client, judge, 'request_withdrawal', [args.slug])
    else:
        write(client, judge, 'withdraw_deposit', [args.slug])
    print(json.dumps(client.read_contract(address=judge, function_name='get_deposit', args=[args.slug]), indent=2))
    show_balance(client, token, account.address, 'balance')
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--network', default='studio_devnet', choices=NETWORKS)
    parser.add_argument('--judge', default=None)
    parser.add_argument('--token', default=None)
    sub = parser.add_subparsers(dest='command', required=True)

    def claim_args(p):
        p.add_argument('--request-id', required=True)
        p.add_argument('--clause', required=True)

    p = sub.add_parser('sign', help="the payer's consent to disclose its own response")
    p.add_argument('--request-id', required=True)
    p.set_defaults(fn=cmd_sign)

    p = sub.add_parser('mint', help='faucet-mint settlement tokens')
    p.add_argument('--amount', type=int, default=5_000_000)
    p.set_defaults(fn=cmd_mint)

    p = sub.add_parser('bond', help='escrow the claim bond to the judge')
    p.add_argument('--amount', type=int, default=None)
    p.set_defaults(fn=cmd_bond)

    p = sub.add_parser('deposit', help='provider: bind an escrow to a slug')
    p.add_argument('--slug', required=True)
    p.set_defaults(fn=cmd_deposit)

    p = sub.add_parser('open', help='file a claim')
    claim_args(p)
    p.add_argument('--slug', required=True)
    p.add_argument('--signature', default=os.environ.get('VERDIKT_DISCLOSURE_SIGNATURE'))
    p.set_defaults(fn=cmd_open)

    p = sub.add_parser('resolve', help='have the claim judged')
    claim_args(p)
    p.set_defaults(fn=cmd_resolve)

    p = sub.add_parser('cancel', help='abandon an open claim; settles nothing against either side')
    claim_args(p)
    p.set_defaults(fn=cmd_cancel)

    p = sub.add_parser('status', help='read a claim back')
    claim_args(p)
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser('balance', help='balances, escrow and bonded total')
    p.set_defaults(fn=cmd_balance)

    p = sub.add_parser('withdraw', help='provider: release a deposit (two steps)')
    p.add_argument('--slug', required=True)
    p.add_argument('--request', action='store_true', help='step one: start the cooldown')
    p.set_defaults(fn=cmd_withdraw)

    args = parser.parse_args()
    return args.fn(args)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 — a CLI should say what went wrong, not traceback
        print(f'error: {error}', file=sys.stderr)
        raise SystemExit(1)
