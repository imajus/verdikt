"""
Shared network resolution for the CLI scripts (`deploy.py`, `claim.py`,
`export-claims.py`).

`studio_devnet` is GenLayer's Agent Tank submission target — chain id 61997,
<https://studio-dev.genlayer.com/api>, documented as the release-candidate
environment for the next Studio and consensus stack. It is a built-in chain in
the `genlayer-py` this repo pins; on the older `0.18` line it did not exist at
all, which is why the deploy script used to name Bradbury.

Reaching it takes four things, and missing any one of them fails in a way that
looks like a different problem:

1. **The v0.19 client.** The v1 client reverts against the consensus contract
   with no reason attached — the next stack does not understand it.
2. **An explicit fee distribution.** The client otherwise encodes an all-zero
   `FeesDistribution` and consensus rejects it as `FeesDistributionMissing`
   (genlayer-cli#421). `deploy.py` passes `estimate_fees_distribution()`.
3. **The v0.6 runner.** The contracts pin `py-genlayer:5jycge4q…`; the older
   `1jb45aa8…` is refused outright as `invalid_contract runner malformed`.
   That runner also brings the new SDK surface — `import genlayer as gl`,
   `gl.contract.Contract` — which is why the contracts are written against it.
4. **Patience.** Consensus here takes minutes, not the 30s the client waits by
   default, and a premature give-up reads as a failure rather than as waiting.
"""

import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

NETWORKS = ('localnet', 'studionet', 'testnet_asimov', 'testnet_bradbury', 'studio_devnet')

# Consensus on studio_devnet routinely runs past the client's 30s default, and
# a timeout there is indistinguishable from a failed deploy to anyone reading
# the output. Eight minutes is slack, not an estimate.
DEPLOY_WAIT_INTERVAL_MS = 5_000
DEPLOY_WAIT_RETRIES = 95


def resolve_chain(genlayer_py, network: str):
    """The chain object a client is built from."""
    return getattr(genlayer_py, network)


def load_deployment(network: str) -> dict:
    """
    The checked-in record of what is deployed on this network, or `{}`.

    This is the source of truth for the judge and token addresses, the way
    `deployments/arc-testnet.json` is for the registry: neither address is
    secret nor varies by environment, so neither belongs in `.env`, where every
    contributor has to be handed it out of band and nothing can validate it
    (`packages/sdk/deployments.js`). Flags and env vars override it for a fork
    or a second deployment — they are not the normal path.
    """
    path = REPO / 'deployments' / deployment_filename(network)
    return json.loads(path.read_text()) if path.exists() else {}


def deployment_filename(network: str) -> str:
    """`deployments/genlayer-<label>.json`. `testnet_` is stripped and `_` is
    normalized to `-` so `studio_devnet` reads as `studio-devnet`, matching the
    hyphenated labels the other networks already produce (`bradbury`,
    `asimov`)."""
    return f'genlayer-{network.replace("testnet_", "").replace("_", "-")}.json'
