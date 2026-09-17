// The claimant's CLI, in JavaScript: file a semantic claim and follow it.
//
// `genlayer/scripts/claim.py` is the same tool in Python and stays the one the
// repo's how-to documents. This exists because an agent that wants to dispute a
// call it paid for may have no Python toolchain, and the one this repo uses
// wants a virtualenv, an SDK pinned to a git ref, and a 310MB GenVM artifact
// cache.
//
// It covers the claimant's path only — sign, mint, bond, open, status, cancel.
// Resolving is a bounty hunter's job and `runner/bin/resolve-claims.mjs`
// already does it from a distinct account, which is what keeps a MET outcome
// costing the claimant its bounty. Deposits and withdrawals are the provider's
// side.

import { chains, createAccount, createClient } from 'genlayer-js';
import deployment from '../deployments/genlayer-studio-devnet.json' with { type: 'json' };
import { describeFailure, settlementAllocations } from './genlayer-fees.mjs';

/**
 * Mirrors `disclosureMessage` in proxy/src/evidence.js and DISCLOSURE_PREFIX in
 * genlayer/scripts/claim.py. All three must match byte for byte: the proxy
 * discloses evidence only to whoever signs this exact string, so a drift makes
 * every disclosure refuse.
 */
export const DISCLOSURE_PREFIX = 'Verdikt evidence disclosure\nrequest: ';

/** @param {string} requestId */
export const disclosureMessage = (requestId) => `${DISCLOSURE_PREFIX}${requestId.toLowerCase()}`;
