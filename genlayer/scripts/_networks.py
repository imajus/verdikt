"""
Shared network resolution for the CLI scripts (`deploy.py`, `claim.py`,
`export-claims.py`).

`studio_dev` is GenLayer's Agent Tank submission target (chain id 61997,
<https://studio-dev.genlayer.com/api>) and it is not one of `genlayer_py`'s
four built-in chains (`localnet`, `studionet`, `testnet_asimov`,
`testnet_bradbury` — see `genlayer_py.chains`). GenLayer's own TypeScript SDK
carries it as `studioDevnet`: `studionet` spread with only `id`, `name`,
`rpc_urls` and `block_explorers` overridden — the consensus/fee/staking
contract addresses are the same ones studionet uses, because it is the same
consensus deployment fronted by a different RPC for pre-release testing. This
mirrors that, since `genlayer_py` 0.18.0 has no equivalent built in.

**Deploying to it currently reverts.** Every write — even a plain,
non-`nondet` deploy — reverts against the consensus contract with no leader
receipt, on chain id 61997 through this RPC. That is a known, open, upstream
bug (genlayer-cli#421, "FeesDistributionMissing", filed the day before this
was written) affecting the standard SDK deploy path for anyone targeting this
network, not something wrong in this repo's config. `deploy.py --network
studio_dev --dry-run` still works (it only reads a balance); the real deploy
will not until GenLayer fixes it upstream.

`gltest` (`tests/integration`) cannot be pointed at this network at all: its
`chain_type` config resolves to genlayer_py's unmodified preset chain object,
ignoring any `id`/`url` override for anything but the RPC endpoint — so
`tests/integration` stays on `studionet`/`testnet_bradbury`, and it is not a
gap this file can close.
"""

import dataclasses

NETWORKS = ('localnet', 'studionet', 'testnet_asimov', 'testnet_bradbury', 'studio_dev')

STUDIO_DEV_CHAIN_ID = 61_997
STUDIO_DEV_RPC_URL = 'https://studio-dev.genlayer.com/api'


def resolve_chain(genlayer_py, network: str):
    """The chain object a client is built from. Everything but `studio_dev`
    is a straight attribute lookup on the `genlayer_py` module."""
    if network != 'studio_dev':
        return getattr(genlayer_py, network)
    return dataclasses.replace(
        genlayer_py.studionet,
        id=STUDIO_DEV_CHAIN_ID,
        name='GenLayer Studio Devnet',
        rpc_urls={'default': {'http': [STUDIO_DEV_RPC_URL]}},
        # The stable Studio explorer does not index this preview deployment.
        block_explorers={},
    )


def deployment_filename(network: str) -> str:
    """`deployments/genlayer-<label>.json`. `testnet_` is stripped and `_` is
    normalized to `-` so `studio_dev` reads as `studio-dev`, matching the
    hyphenated labels the other networks already produce (`bradbury`,
    `asimov`)."""
    return f'genlayer-{network.replace("testnet_", "").replace("_", "-")}.json'
