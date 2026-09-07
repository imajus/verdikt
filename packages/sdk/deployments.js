// @verdikt/sdk/deployments — where Verdikt's own contracts live.
//
// Checked into the repo rather than kept in `.env`, because they are neither
// secret nor environment-varying: the registry on Arc Testnet is at the same
// address for every developer, for CI, and for the dashboard. An address in
// `.env` is one that every contributor has to be handed out of band, and that
// nothing can validate.
//
// What stays in `.env` is what genuinely differs per environment — an RPC URL,
// a key, a port — plus an override here for anyone pointing at a fork.
//
// Note the boundary: ENSv2's *protocol* addresses are not here either. Those
// are constants of someone else's deployment and live in
// `scripts/ens-sepolia.mjs` and `ens.js`, which is what keeps one file knowing
// the ENSv2 deployment (CLAUDE.md).

import arcTestnetDeployment from '../../deployments/arc-testnet.json' with { type: 'json' };
import sepoliaDeployment from '../../deployments/sepolia.json' with { type: 'json' };

export const DEPLOYMENTS = Object.freeze({
  'arc-testnet': arcTestnetDeployment,
  sepolia: sepoliaDeployment
});

/** Verdikt's Arc deployment. `registry` is null until Tasks.md 2.4 unblocks. */
export const ARC = arcTestnetDeployment;

/** Verdikt's Sepolia namespace. */
export const SEPOLIA = sepoliaDeployment;
