// What a service's 402 actually asks for, before you pay for it.
//
//   node .claude/skills/verdikt-paid-call-sweep/scripts/challenge.mjs <slug|url> [--method POST] [--raw]
//   node .claude/skills/verdikt-paid-call-sweep/scripts/challenge.mjs --all
//
// `--all` walks whatever is registered right now, so a sweep never depends on a
// remembered list of services.
//
// Three things make this worth a script rather than a curl.
//
// 1. The challenge is not always in the body. Most providers answer 402 with
//    the JSON challenge as the body; some answer `content-length: 0` and put
//    the same document in a base64 `payment-required` header. A plain
//    `curl | jq` sees nothing there and reads like a broken endpoint.
//
// 2. The request shape is usually *in* the challenge, and it hides in more than
//    one place — `accepts[].outputSchema.input.body` for some providers,
//    `extensions.bazaar.schema` for others. Both are authoritative. Reading one
//    beats guessing a payload, and on a provider that charges before it
//    validates, a guessed payload is a paid mistake.
//
// 3. Whether you can pay at all is a property of the challenge: a non-EVM
//    network cannot be paid from a Circle agent wallet, and Gateway vs vanilla
//    decides which ledger drains.
//
// Nothing here spends money: a 402 is what an unpaid request is *supposed* to
// get back, so this is free to run against every service as often as you like.

import { createRegistryReader } from '../../../../packages/sdk/arc.js';
import { json, loadEnv } from './lib.mjs';

loadEnv();

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const raw = flag('--raw');
const method = (value('--method') ?? 'POST').toUpperCase();

/**
 * A 404 body like `{"error":"Endpoint not found"}` parses as JSON perfectly
 * well, so "did it parse" is not the same question as "is this a challenge".
 * Without this check a routing error reads as a challenge with no accepts and
 * no schema, which looks like a provider that published neither.
 * @param {any} candidate
 */
const isChallenge = (candidate) =>
  Boolean(candidate) &&
  typeof candidate === 'object' &&
  (Array.isArray(candidate.accepts) || 'x402Version' in candidate);

/** @param {string} target a slug or a full URL */
async function fetchChallenge(target) {
  const url = target.startsWith('http') ? target : `https://${target}.verdikt.bond/`;
  // POST by default, not GET. Many upstreams expose their paid resource on a
  // POST route, so a GET reaches the provider and comes back 404/405 — its own
  // routing error, never a 402 — which makes a payable service look dead.
  // `circle services inspect` has the same default and the same blind spot.
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : '{}'
  });
  const text = await response.text();

  let challenge = null;
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text);
      if (isChallenge(parsed)) challenge = parsed;
    } catch {
      /* Not JSON — fall through to the header. */
    }
  }
  // The header form carries the same base64 document. The
  // `www-authenticate: Payment …` header some providers send alongside it is a
  // different, non-x402 scheme, so it is not a substitute.
  if (!challenge) {
    const header = response.headers.get('payment-required');
    if (header) {
      try {
        const parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
        if (isChallenge(parsed)) challenge = parsed;
      } catch {
        /* Leave null and report the status instead. */
      }
    }
  }
  return { url, response, text, challenge };
}

/** @param {string} target */
async function report(target) {
  const { url, response, text, challenge } = await fetchChallenge(target);
  console.log(`${method} ${url} -> HTTP ${response.status}`);

  if (!challenge) {
    console.log(
      response.status === 402
        ? '  A 402 with no challenge in the body or the payment-required header.'
        : `  Not a payment challenge. Body: ${text.slice(0, 200) || '(empty)'}\n` +
            (response.status === 404 || response.status === 405
              ? "  That is the upstream's own routing error, not a Verdikt refusal — try another\n" +
                '  --method before concluding the service is down.'
              : '')
    );
    return false;
  }

  if (raw) {
    console.log(json(challenge));
    return true;
  }

  const resource = challenge.resource ?? {};
  if (resource.url) console.log(`  resource  ${resource.method ?? ''} ${resource.url}`.replace('   ', '  '));
  if (resource.description) console.log(`  about     ${resource.description}`);

  let payable = false;
  for (const accept of challenge.accepts ?? []) {
    const scheme = accept.extra?.name ?? accept.scheme;
    // Any non-eip155 network is unreachable from a Circle agent wallet, which
    // is EVM-only. Flagged per option rather than per service, because a
    // provider commonly offers several and only some are payable.
    const evm = String(accept.network ?? '').startsWith('eip155:');
    if (evm) payable = true;
    console.log(
      `  accepts   ${accept.network}  ${accept.amount} minor units  via ${scheme}` +
        (evm ? '' : '  [not payable from a Circle agent wallet]')
    );
    if (accept.description) console.log(`            ${accept.description}`);
  }
  if (!payable) console.log('  NOTE      no EVM option — this service cannot be paid from a Circle agent wallet.');

  // Where the request schema hides, by provider family.
  const body =
    (challenge.accepts ?? []).map((accept) => accept.outputSchema?.input?.body).find(Boolean) ??
    challenge.extensions?.bazaar?.schema?.properties?.input?.properties?.body;

  if (body) {
    const required = body.required ?? [];
    console.log(
      `  schema    required: ${required.length ? required.join(', ') : '(none declared)'}` +
        `  ·  optional: ${Object.keys(body.properties ?? {})
          .filter((key) => !required.includes(key))
          .join(', ') || '(none)'}`
    );
    console.log(json(body).replace(/^/gm, '  '));
  } else {
    console.log(
      '  schema    not published in the challenge. Consult the upstream provider\'s own API docs —\n' +
        `            its base URL is the resource above${resource.url ? '' : ' (or the service\'s ENS `url` record)'}.`
    );
  }
  return true;
}

if (flag('--all')) {
  const registry = createRegistryReader(
    process.env.ARC_RPC_URL ? {} : { maxBlockRange: 500n, scanConcurrency: 2 }
  );
  const services = (await registry.listServices()).filter((service) => service.status !== 'DEREGISTERED');
  console.log(`${services.length} listed services\n`);
  for (const service of services) {
    console.log(`=== ${service.slug} ===`);
    try {
      await report(service.slug);
    } catch (error) {
      console.log(`  unreachable: ${error.message}`);
    }
    console.log();
  }
} else {
  const target = args.find((argument) => !argument.startsWith('--') && argument !== method);
  if (!target) {
    console.error('usage: challenge.mjs <slug|url> [--method POST] [--raw]   |   challenge.mjs --all');
    process.exit(1);
  }
  const ok = await report(target);
  process.exit(ok ? 0 : 1);
}
