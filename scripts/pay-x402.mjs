// Make a real x402 payment against a live paywall (Tasks.md 0.4, Spike C).
//
// WHY THIS EXISTS
//
// Spike C was recorded as blocked on Circle: the demo paywall's Arc option is
// `GatewayWalletBatched`, which needs a Circle-managed agent wallet (email OTP,
// plus a terms acceptance that is the operator's to give). That is still true.
//
// But the same challenge also offers `scheme: "exact"` with
// `extra.assetTransferMethod: "eip3009"`, and *that* is an open standard end to
// end — x402's envelope over an ERC-3009 `TransferWithAuthorization`. It needs
// no Circle wallet and no gas in the payer's account, because the facilitator
// submits the transfer. It needs exactly one thing: USDC at the paying address
// on the option's chain.
//
// So this script is the whole remaining spike, minus the funding. Point it at
// the paywall with a funded key and it captures the live header and whatever
// the facilitator returns.
//
//   VERDIKT_PAYER_PRIVATE_KEY=0x… node scripts/pay-x402.mjs <url> [--send]
//
// Without --send it signs and prints the header but does not spend.
//
// WHAT A DRY RUN AGAINST THE DEMO PAYWALL ALREADY ESTABLISHED
//
// It answers 402 identically for: no header, unparseable garbage, a well-formed
// envelope with a nonsense signature, and a well-formed envelope correctly
// signed by an unfunded account. No error body, no `x-payment-response` header,
// nothing that distinguishes them. So there is no cheap way to learn the
// settlement shape by provoking a failure — only a payment that actually
// settles produces new information, which is why funding is the blocker rather
// than protocol knowledge.

import { privateKeyToAccount } from 'viem/accounts';

const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
  ]
};

const url = process.argv[2];
const send = process.argv.includes('--send');
if (!url) throw new Error('usage: node scripts/pay-x402.mjs <paywall-url> [--send]');

const key = process.env.VERDIKT_PAYER_PRIVATE_KEY;
if (!key) throw new Error('set VERDIKT_PAYER_PRIVATE_KEY to a key holding USDC on the option\'s chain');
const payer = privateKeyToAccount(/** @type {`0x${string}`} */ (key));

const challenge = await (await fetch(url)).json();
const option = challenge.accepts?.find((entry) => entry?.extra?.assetTransferMethod === 'eip3009');
if (!option) {
  throw new Error(
    'this paywall offers no eip3009 option. The other schemes on offer are ' +
      `${(challenge.accepts ?? []).map((a) => a?.extra?.name).join(', ')}, whose payloads are not published.`
  );
}

console.log(`paying as   ${payer.address}`);
console.log(`option      ${option.scheme} / ${option.network} / ${option.extra.name}`);
console.log(`amount      ${option.amount} minor units of ${option.asset}`);
console.log(`payTo       ${option.payTo}`);

const now = Math.floor(Date.now() / 1000);
const authorization = {
  from: payer.address,
  to: option.payTo,
  value: option.amount,
  validAfter: '0',
  validBefore: String(now + (option.maxTimeoutSeconds ?? 300)),
  // Not a counter: ERC-3009 nonces are arbitrary and only need to be unused, so
  // a random one cannot collide with a concurrent payment from the same key.
  nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`
};

const signature = await payer.signTypedData({
  domain: {
    name: option.extra.name,
    version: option.extra.version,
    chainId: Number(option.network.split(':')[1]),
    verifyingContract: option.asset
  },
  types: TRANSFER_WITH_AUTHORIZATION,
  primaryType: 'TransferWithAuthorization',
  message: {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce
  }
});

const header = Buffer.from(
  JSON.stringify({
    x402Version: challenge.x402Version ?? 2,
    scheme: option.scheme,
    network: option.network,
    payload: { signature, authorization }
  })
).toString('base64');

console.log(`\nX-PAYMENT (${header.length} bytes):\n${header}`);

if (!send) {
  console.log('\ndry run — pass --send to spend. Nothing was paid.');
  process.exit(0);
}

const response = await fetch(url, { headers: { 'X-PAYMENT': header } });
console.log(`\nHTTP ${response.status} ${response.statusText}`);
for (const [name, value] of response.headers) {
  if (/payment|x402/i.test(name)) console.log(`  ${name}: ${value.slice(0, 120)}`);
}
console.log(`\n${(await response.text()).slice(0, 2000)}`);

if (response.status === 402) {
  console.log(
    '\nStill 402. This paywall returns an identical 402 for every kind of refusal, ' +
      'so check the payer actually holds USDC on that chain — that is the usual cause ' +
      'and the response will not say so.'
  );
}
