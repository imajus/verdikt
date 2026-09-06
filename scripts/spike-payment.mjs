#!/usr/bin/env node
// Spike C — X-PAYMENT decoding (Tasks.md 0.4).
//
// Run:  node scripts/spike-payment.mjs            # offline: regenerate + verify fixtures
//       node scripts/spike-payment.mjs --live     # also re-check the Arc Testnet constants over RPC
//
// This script is the spike's executable evidence and the fixture generator in
// one file. It rewrites fixtures/x402.js from the constants below, so the
// committed fixtures are reproducible rather than hand-typed — re-running it
// on an unchanged tree is a no-op, which is the check that nothing drifted.
//
// WHAT IT PROVES
//
//   1. `X-PAYMENT` is base64(JSON) of an x402 v2 PaymentPayload, and the
//      payer and amount live in `payload.authorization.{from,value}`.
//   2. Those two fields are covered by an EIP-712 signature over an EIP-3009
//      `TransferWithAuthorization` message: recovering the signature yields
//      `authorization.from`, so naming someone else's address as payer means
//      forging their signature. This is the question Tasks.md 0.4 exists to
//      answer, and the answer is yes — they are bound, not merely asserted.
//   3. Tampering with either field breaks recovery. The negative cases below
//      are the actual proof; #2 alone would also be satisfied by a decoder
//      that ignored the signature entirely.
//
// WHAT IT DOES NOT PROVE — see docs/spikes/C-x402-payment.md §4.
// A signed authorization is an *intent to pay*, not a settled payment. The
// enclave must still confirm settlement before writing a verdict.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak256, toHex, getAddress, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- constants
//
// Every address and id below was read back from a live source rather than
// copied from prose — see the "verified against" note on each. `--live`
// re-runs the Arc Testnet reads.

/** Arc Testnet. `eth_chainId` on https://rpc.testnet.arc.network returns 0x4cef52. */
const ARC_TESTNET_CHAIN_ID = 5042002;
const ARC_TESTNET_NETWORK = `eip155:${ARC_TESTNET_CHAIN_ID}`;

/** USDC on Arc Testnet. `decimals()` returns 6, `symbol()` returns "USDC". */
const ARC_TESTNET_USDC = '0x3600000000000000000000000000000000000000';

/**
 * Circle's testnet GatewayWallet — the EIP-712 `verifyingContract` for the
 * batched scheme, and NOT the USDC address. From `CHAIN_CONFIGS.arcTestnet`
 * in @circle-fin/x402-batching@3.4.0; `eth_getCode` on Arc Testnet confirms
 * a deployed proxy at this address.
 */
const TESTNET_GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';

/** From @circle-fin/x402-batching@3.4.0 `src/constants.ts`. */
const CIRCLE_BATCHING_NAME = 'GatewayWalletBatched';
const CIRCLE_BATCHING_VERSION = '1';
const CIRCLE_BATCHING_SCHEME = 'exact';
/** 7 days + 100s. The signed authorization stays valid for a week — see §4. */
const GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS = 7 * 24 * 60 * 60 + 100;

/**
 * The EIP-3009 struct. Identical in @x402/evm's vanilla `exact` scheme and in
 * Circle's batched one — only the domain differs — so one recovery routine
 * covers both, which is what lets the proxy relay whatever a provider
 * advertises (Specification.md §2).
 */
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
  ]
};

// ------------------------------------------------------------- test signers
//
// Anvil's default mnemonic, accounts 0 and 1. These keys are published in
// Foundry's own documentation and hold nothing anywhere — they are here so
// the committed fixture carries a signature that actually verifies, and so
// anyone can regenerate it byte-for-byte. Never reuse them for anything real.
const PAYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PROVIDER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

// ------------------------------------------------------------ fixed clock
//
// A recorded artefact must not change when the machine's clock does, so the
// window below is frozen. It is shaped exactly as the Circle client shapes
// one: `validAfter = issued - 600`, `validBefore = issued + max(
// maxTimeoutSeconds, GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS)`.
const ISSUED_AT = 1788700000; // 2026-09-06T13:06:40Z
const MAX_TIMEOUT_SECONDS = 300;

const RESOURCE = {
  url: 'https://weather.verdikt.bond/v1/forecast',
  description: 'Open-Meteo current conditions, x402-gated',
  mimeType: 'application/json'
};

/** $0.0025. USDC has 6 decimals, so the wire value is an integer string. */
const AMOUNT_MINOR_UNITS = '2500';

/**
 * Deterministic stand-in for the 32 random bytes the client draws. Gateway
 * enforces uniqueness per authorization at settlement, which is why this
 * doubles as the registry's `requestId` (Specification.md §3).
 */
const NONCE = keccak256(toHex('verdikt/spike-c/authorization-nonce/1'));

// ------------------------------------------------------------------ build

const payer = privateKeyToAccount(PAYER_KEY);
const provider = privateKeyToAccount(PROVIDER_KEY);

/** The `accepts[0]` entry of the provider's 402, and the payload's `accepted`. */
const requirements = {
  scheme: CIRCLE_BATCHING_SCHEME,
  network: ARC_TESTNET_NETWORK,
  amount: AMOUNT_MINOR_UNITS,
  asset: getAddress(ARC_TESTNET_USDC),
  payTo: provider.address,
  maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  extra: {
    name: CIRCLE_BATCHING_NAME,
    version: CIRCLE_BATCHING_VERSION,
    verifyingContract: getAddress(TESTNET_GATEWAY_WALLET)
  }
};

const challenge = {
  x402Version: 2,
  error: 'Payment Required',
  resource: RESOURCE,
  accepts: [requirements]
};

const authorization = {
  from: payer.address,
  to: provider.address,
  value: AMOUNT_MINOR_UNITS,
  validAfter: String(ISSUED_AT - 600),
  validBefore: String(
    ISSUED_AT + Math.max(MAX_TIMEOUT_SECONDS, GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS)
  ),
  nonce: NONCE
};

const domain = {
  name: requirements.extra.name,
  version: requirements.extra.version,
  chainId: ARC_TESTNET_CHAIN_ID,
  verifyingContract: requirements.extra.verifyingContract
};

const message = {
  from: getAddress(authorization.from),
  to: getAddress(authorization.to),
  value: BigInt(authorization.value),
  validAfter: BigInt(authorization.validAfter),
  validBefore: BigInt(authorization.validBefore),
  nonce: authorization.nonce
};

const signature = await payer.signTypedData({
  domain,
  types: AUTHORIZATION_TYPES,
  primaryType: 'TransferWithAuthorization',
  message
});

const paymentPayload = {
  x402Version: 2,
  resource: RESOURCE,
  accepted: requirements,
  payload: { authorization, signature }
};

/** x402's own encoding: `safeBase64Encode(JSON.stringify(payload))`, standard alphabet. */
const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

const header = encode(paymentPayload);

/**
 * The settlement receipt the provider returns on the paid 200, as
 * `X-PAYMENT-RESPONSE`. Shape is @x402/core's `SettleResponse`. This one is
 * synthetic — see the honesty note in fixtures/x402.js.
 */
const settlement = {
  success: true,
  transaction: `0x${createHash('sha256').update(header).digest('hex')}`,
  network: ARC_TESTNET_NETWORK,
  payer: payer.address
};

// A payload naming a different payer while keeping the payer's real
// signature. This is the exact attack Tasks.md 0.4 asks about: it must not
// decode. The address is Anvil account 2 — the "attacker" the fixture names.
const attacker = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
const tamperedPayer = encode({
  ...paymentPayload,
  payload: { authorization: { ...authorization, from: attacker }, signature }
});

// Same signature, inflated amount. Also must not decode.
const tamperedAmount = encode({
  ...paymentPayload,
  accepted: { ...requirements, amount: '250000' },
  payload: { authorization: { ...authorization, value: '250000' }, signature }
});

// ----------------------------------------------------------------- verify

const recovered = await recoverTypedDataAddress({
  domain,
  types: AUTHORIZATION_TYPES,
  primaryType: 'TransferWithAuthorization',
  message,
  signature
});

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

console.log('Spike C — X-PAYMENT decoding\n');
check('header is base64 of JSON', /^[A-Za-z0-9+/]*={0,2}$/.test(header));
check('recovered signer == authorization.from', recovered === payer.address, recovered);
check('authorization.value == accepts[0].amount', authorization.value === requirements.amount);
check('authorization.to == accepts[0].payTo', authorization.to === requirements.payTo);
check(
  'domain.verifyingContract is the GatewayWallet, not USDC',
  domain.verifyingContract !== getAddress(ARC_TESTNET_USDC),
  domain.verifyingContract
);

for (const [name, tampered] of [
  ['tampered payer does not recover', tamperedPayer],
  ['tampered amount does not recover', tamperedAmount]
]) {
  const decoded = JSON.parse(Buffer.from(tampered, 'base64').toString('utf8'));
  const auth = decoded.payload.authorization;
  const got = await recoverTypedDataAddress({
    domain,
    types: AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: getAddress(auth.from),
      to: getAddress(auth.to),
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce
    },
    signature: decoded.payload.signature
  });
  check(name, got !== getAddress(auth.from), `recovers to ${got}`);
}

if (process.argv.includes('--live')) {
  const rpc = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
  const call = async (method, params) => {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    return (await res.json()).result;
  };
  const chainId = await call('eth_chainId', []);
  const decimals = await call('eth_call', [{ to: ARC_TESTNET_USDC, data: '0x313ce567' }, 'latest']);
  const code = await call('eth_getCode', [TESTNET_GATEWAY_WALLET, 'latest']);
  check('live: chainId is Arc Testnet', Number(chainId) === ARC_TESTNET_CHAIN_ID, chainId);
  check('live: USDC decimals == 6', Number(decimals) === 6, String(Number(decimals)));
  check('live: GatewayWallet is deployed', typeof code === 'string' && code.length > 2);
}

// ------------------------------------------------------------ emit fixture

// Emit JS object literals rather than JSON.stringify output so the generated
// file reads like the rest of the repo (single quotes, bare keys).
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const json = (value, indent = '') => {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = value.map((v) => `${indent}  ${json(v, `${indent}  `)}`).join(',\n');
    return `[\n${inner}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const inner = entries
      .map(([k, v]) => `${indent}  ${IDENT.test(k) ? k : `'${k}'`}: ${json(v, `${indent}  `)}`)
      .join(',\n');
    return `{\n${inner}\n${indent}}`;
  }
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return String(value);
};

const file = `// @verdikt/fixtures/x402 — recorded and reproducible x402 artefacts for the
// Arc Testnet payment leg (Tasks.md 0.4, 0.5).
//
// GENERATED by scripts/spike-payment.mjs. Edit that, re-run it, commit both.
//
// PROVENANCE — what is real here and what is not:
//
//   Real, read back from a live source:
//     - the Arc Testnet chain id, the USDC address and its 6 decimals
//       (eth_chainId / decimals() against https://rpc.testnet.arc.network)
//     - the GatewayWallet address, which has deployed code on Arc Testnet
//     - the payload and challenge SHAPES, taken from @x402/core@2.25.0 and
//       @circle-fin/x402-batching@3.4.0, and cross-checked against a live
//       402 from a production x402 seller (see PRODUCTION_402_CHALLENGE)
//     - the EIP-712 signature: a genuine secp256k1 signature that recovers
//       to PAYER, over the same struct and domain Circle's client signs
//
//   Synthetic:
//     - the payer and provider identities (Anvil test accounts)
//     - the amount, the resource URL, and the frozen validity window
//     - SETTLEMENT_RECEIPT — no payment has actually settled on Arc yet
//
// So these exercise decoding, binding and the failure modes end to end, but
// they are NOT evidence that a payment settled. Replace SETTLEMENT_RECEIPT
// with a captured one when the demo provider stands up (Tasks.md 0.6).

/** Anvil account 0. Published test key — holds nothing, signs the fixture below. */
export const FIXTURE_PAYER = '${payer.address}';

/** Anvil account 1. The provider's payout address, i.e. the challenge's payTo. */
export const FIXTURE_PROVIDER_PAYOUT = '${provider.address}';

/** Anvil account 2. Names the payer an attacker would try to substitute. */
export const FIXTURE_ATTACKER = '${attacker}';

export const FIXTURE_SLUG = 'weather';

/** \`eth_chainId\` on https://rpc.testnet.arc.network returns 0x4cef52. */
export const ARC_TESTNET_CHAIN_ID = ${ARC_TESTNET_CHAIN_ID};

/** CAIP-2. x402 v2 carries the network in this form; v1 used bare names. */
export const ARC_TESTNET_NETWORK = '${ARC_TESTNET_NETWORK}';

/** USDC on Arc Testnet — \`decimals()\` returns 6, \`symbol()\` returns "USDC". */
export const ARC_TESTNET_USDC = '${getAddress(ARC_TESTNET_USDC)}';

/**
 * Circle's testnet GatewayWallet: the EIP-712 \`verifyingContract\` for the
 * batched scheme. Deliberately NOT the USDC address — under the vanilla
 * \`exact\` scheme it would be, and reading it from the wrong place is the
 * easiest way to make every signature fail to recover.
 */
export const TESTNET_GATEWAY_WALLET = '${getAddress(TESTNET_GATEWAY_WALLET)}';

/**
 * The provider's 402 body. The proxy's passthrough branch checks
 * \`accepts[0].payTo\` against the ENS address record before relaying this
 * (Specification.md §4).
 */
export const PAYMENT_REQUIRED_CHALLENGE = Object.freeze(${json(challenge)});

/**
 * A 402 recorded from a live production x402 seller (blockrun.ai, Base
 * mainnet, 2026-09-06). Kept because it is the one artefact here nobody
 * generated: it confirms the v2 PaymentRequirements shape — string \`amount\`
 * in minor units, CAIP-2 \`network\`, EIP-712 \`extra\` — against real traffic,
 * and it is the vanilla \`exact\` variant, where \`extra\` names the USDC token
 * itself rather than a GatewayWallet. Verdikt has to decode both
 * (Specification.md §2).
 */
export const PRODUCTION_402_CHALLENGE = Object.freeze({
  x402Version: 2,
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '263500',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0xe9030014F5DAe217d0A152f02A043567b16c1aBf',
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' }
    }
  ],
  error: 'Payment Required'
});

/** The decoded \`X-PAYMENT\` payload, before base64. */
export const PAYMENT_PAYLOAD = Object.freeze(${json(paymentPayload)});

/** The \`X-PAYMENT\` header value itself: base64 of \`PAYMENT_PAYLOAD\`. */
export const X_PAYMENT_HEADER =
  '${header}';

/** What \`decodePayment(X_PAYMENT_HEADER)\` must return. */
export const DECODED_PAYMENT = Object.freeze({
  payer: FIXTURE_PAYER,
  amount: ${AMOUNT_MINOR_UNITS}n,
  asset: ARC_TESTNET_USDC,
  network: ARC_TESTNET_NETWORK,
  payTo: FIXTURE_PROVIDER_PAYOUT,
  scheme: '${CIRCLE_BATCHING_SCHEME}',
  nonce: '${NONCE}',
  validAfter: ${authorization.validAfter}n,
  validBefore: ${authorization.validBefore}n
});

/**
 * \`X-PAYMENT\` naming a different payer while keeping the real signature —
 * the attack Tasks.md 0.4 asks about. \`decodePayment\` must reject it.
 */
export const X_PAYMENT_HEADER_TAMPERED_PAYER =
  '${tamperedPayer}';

/** \`X-PAYMENT\` with the amount inflated 100x. Must also be rejected. */
export const X_PAYMENT_HEADER_TAMPERED_AMOUNT =
  '${tamperedAmount}';

/**
 * The \`X-PAYMENT-RESPONSE\` receipt on the paid 200. SYNTHETIC — the
 * \`transaction\` hash points at nothing. It exists because a signed
 * authorization is an intent to pay and not a settlement, so the enclave has
 * to check a receipt before writing a verdict, and that path needs a fixture
 * to develop against.
 */
export const SETTLEMENT_RECEIPT = Object.freeze(${json(settlement)});

/** The base64 \`X-PAYMENT-RESPONSE\` header carrying the receipt above. */
export const X_PAYMENT_RESPONSE_HEADER =
  '${encode(settlement)}';
`;

writeFileSync(join(ROOT, 'fixtures/x402.js'), file);
console.log('\nwrote fixtures/x402.js');

const failed = checks.filter((c) => !c.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
console.log(`${checks.length} checks passed`);
