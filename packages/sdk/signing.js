// @verdikt/sdk/signing — EIP-191 signing, kept here for the same reason the ABI
// and the ENS deployment are: viem is a dependency of this package and of
// nothing downstream. The proxy needs to sign the CRE gateway's `alg: "ETH"`
// JWT with its own key, and importing viem there would put a second package in
// the business of knowing how an Ethereum signature is made.

import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * The address a private key signs as.
 * @param {string} privateKey
 * @returns {string}
 */
export const addressOf = (privateKey) => privateKeyToAccount(/** @type {`0x${string}`} */ (privateKey)).address;

/**
 * EIP-191 `personal_sign`: prefixes "\x19Ethereum Signed Message:\n<len>",
 * keccak256s, and signs. Returns 65 bytes as `0x` hex — r ‖ s ‖ v.
 *
 * @param {string} privateKey
 * @param {string} message
 * @returns {Promise<string>}
 */
export const signPersonalMessage = (privateKey, message) =>
  privateKeyToAccount(/** @type {`0x${string}`} */ (privateKey)).signMessage({ message });

/**
 * Recover and compare. Used by the tests, and by anything that has to check a
 * signature it did not produce.
 *
 * @param {string} address
 * @param {string} message
 * @param {string} signature
 * @returns {Promise<boolean>}
 */
export const verifyPersonalMessage = (address, message, signature) =>
  verifyMessage({
    address: /** @type {`0x${string}`} */ (address),
    message,
    signature: /** @type {`0x${string}`} */ (signature)
  });
