# Provider console, navigation, and self-serve onboarding

Status: approved. Implements the requested UI work: a main menu with GitHub/X
links, a SIWE-gated provider console with wallet-signed writes (SLA updates,
top-ups, retirement, new-service onboarding), and the on-chain piece that
makes self-serve onboarding possible without Verdikt holding a key.

## Why this is bigger than a UI task

The dashboard today is read-only (`web/src/render.js`'s provider view shows
calldata to copy, never sends it) and every write path that exists
(`scripts/onboard-service.mjs`) is an operator-run Node script with two
private keys. "Let a provider self-serve" means giving a connected wallet a
way to do everything that script does, which is EAC-gated on Sepolia to the
`verdikt.eth` operator account. That gate is the crux of this design; see §4.

## 1 · Navigation shell

`web/src/router.js` is the one place that reads/writes the URL:
`?view=marketplace|provider|how`, plus the existing `?service=` and
`?provider=` params, which keep working unchanged — `?provider=0x…` is still
a public, read-only deep link to any provider's page.

`web/src/nav.js` renders the masthead: brand, three nav items, the existing
chain/mode pill, and GitHub (`github.com/imajus/verdikt`) + X
(`x.com/verdict402`) as inline-SVG icon links. **Provider is hidden in demo
mode** — writes need a real chain under them, and demo mode's whole point is
that it doesn't have one.

**How it works** is a new static view, prose drawn from `docs/walkthrough.md`:
the two chains and why each, the request path, the capped refund, why there
is no dispute layer. It's what a cold visitor needs before "conformance 958"
means anything.

## 2 · Wallet and session

`web/src/wallet.js` — the only file that knows a wallet exists, same
choke-point idiom as `packages/sdk/ens.js`. EIP-6963 discovery
(`window.addEventListener('eip6963:announceProvider', …)`) with a
`window.ethereum` fallback; viem `createWalletClient({ transport:
custom(provider) })`. `ensureChain(chainId)` does
`wallet_switchEthereumChain`, falling back to `wallet_addEthereumChain` on
error code 4902 (neither Arc Testnet nor Sepolia is a wallet default). Account
and chain-change events are subscribed, so the page reacts instead of going
stale.

`web/src/session.js` — SIWE via `viem/siwe`'s `createSiweMessage`
(`domain`, `address`, `uri`, `version: '1'`, `chainId`, `nonce`,
`issuedAt`), nonce from `crypto.getRandomValues`, verified in-browser with
`verifySiweMessage`, persisted in `localStorage` with an expiry and cleared
on `accountsChanged`. The UI and the signed statement both say plainly what
this is: proof of address control, not an authorization boundary — every
write below is its own wallet-signed transaction regardless of session state.

If the signed-in address differs from the `?provider=` address being viewed,
the page stays fully readable and the write affordances stay locked, with a
one-line reason.

## 3 · Provider actions

`web/src/actions.js` — thin, one function per write, each declaring its chain
and returning a tx hash for the UI to wait on:

| action | chain | call |
|---|---|---|
| claim subname | Sepolia | `VerdiktSubnameRegistrar.claim(slug, payTo)` |
| register service | Arc | `VerdiktRegistry.register(slug)`, value = `DEPOSIT_AMOUNT()` |
| top up bond | Arc | `VerdiktRegistry.topUp(serviceId)`, value = amount |
| retire service | Arc | `VerdiktRegistry.deregister(serviceId)` |
| publish SLA | Sepolia | resolver `setText(node,'sla',…)` |
| publish URL | Sepolia | resolver `setText(node,'url',…)` |

`setTextCalldata` (`packages/sdk/ens.js`) already builds `{to, data}` for the
last two — `actions.js` sends it instead of only displaying it. The "here is
the transaction, sign it yourself" table stays in the UI as a collapsed
disclosure under each action; it's a property worth keeping, not replacing.

`topUp`'s form shows the shortfall against `DEPOSIT_AMOUNT()` when the
service is SUSPENDED, because `topUp` only reinstates once the bond is back
at *full* deposit (`VerdiktRegistry.sol`), not merely above zero — a partial
top-up would otherwise look like it silently did nothing.

Retirement is `deregister`, labelled "Retire service", never "deactivate":
the contract makes it one-way (the slug can never be registered again —
verdict history is keyed by `serviceId`, and reuse would hand a new provider
the old one's record, subname and route) and it reverts while SUSPENDED. The
confirmation dialog states all three consequences and requires typing the
slug; the button is disabled with a reason when the service is SUSPENDED.

## 4 · The registrar contract

**Verified against the live Sepolia deployment**, not assumed: the ENSv2
`PermissionedRegistry`/`PermissionedResolver` source (pulled from Sourcify,
chain 11155111, matching `deployments/sepolia.json`'s addresses) shows
`register()` requires `ROLE_REGISTRAR` at `ROOT_RESOURCE`
(`RegistryRolesLib.sol`), and `authorizeTextRoles`/`setAddr` resolve through
`EnhancedAccessControl`'s root-fallback (`_effectiveRoles = roles[ROOT_RESOURCE][account] | roles[resource][account]`)
— exactly the mechanism `RESOLVER_ROLES_VERDIKT_NEEDS` already relies on for
the operator account. So a contract holding those same two grants can do
everything `onboard-service.mjs` does today, for any slug, permissionlessly.

`contracts/src/VerdiktSubnameRegistrar.sol` — one entrypoint:

```solidity
function claim(string calldata slug, address payTo) external {
    subRegistry.register(slug, msg.sender, address(0), resolver, 0, expiry);
    resolver.authorizeTextRoles(dnsName, "sla", msg.sender, true);
    resolver.authorizeTextRoles(dnsName, "url", msg.sender, true);
    resolver.authorizeTextRoles(dnsName, "conformance", scoreWriter, true);
    resolver.authorizeTextRoles(dnsName, "availability", scoreWriter, true);
    resolver.setAddr(node, payTo);
}
```

Role bitmap `0` for the claimant (never `ROLE_SET_RESOLVER` — Spike A bypass
#1) and per-key `authorizeTextRoles` (never `authorizeNameRoles` — bypass
#2), same invariants `onboard-service.mjs` already enforces, now enforced in
code that anyone can call instead of in an operator's own care.

**One-time operator setup after deploy** (mirrors `setup-ens.mjs`'s idiom —
plan-then-sign, idempotent):
```
subRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, registrar)
resolver.grantRootRoles(RESOLVER_ROLES_VERDIKT_NEEDS, registrar)
```

`scripts/deploy-registrar.mjs` does the deploy + both grants, read-checked
first (skip what's already granted) like every other script in this
directory.

## 5 · Onboarding wizard

Three steps, one transaction each, **ENS before Arc**:

1. **Claim `<slug>.verdikt.eth`** (Sepolia) — slug validated against the same
   regex as `VerdiktRegistry._assertValidSlug` / `serviceIdOf`; availability
   checked with `readNameState` before submit is enabled.
2. **Register on Arc** — value is `DEPOSIT_AMOUNT()` read live from the
   contract, never hardcoded.
3. **Publish `url` and `sla`** (Sepolia) — SLA validated with `parseSla`
   before it can be sent, same as the existing editor.

Wizard state is derived from the two chains on each render, not from
`localStorage`: a refresh or a dropped wallet mid-flow re-enters at the
correct step because the state it's in *is* the state of the chains.

ENS-first is what makes §6 never fire against your own new service — by the
time Arc registration happens, the subname already agrees.

## 6 · Slug binding (proxy + ENS read path)

A permissionless registrar means `<slug>.verdikt.eth` (Sepolia) and
`serviceIdOf(slug)` (Arc) are two independent first-come claims with nothing
binding them once anyone but the operator can claim either side. Without a
check, Mallory could claim the ENS side of a slug Alice already runs on Arc
— or vice versa — and end up controlling where Alice's callers get relayed
or who they pay.

`packages/sdk/ens.js`'s `ServiceRecord` gains `owner`, read from
`subnameRegistry.getState(anyId(slug)).latestOwner` and batched into the
existing `resolveServiceRecord` round trip — the same file that already owns
every other ENS fact stays the only one that knows the subname registry
exists.

`proxy/src/router.js` already has `state.provider` from `registry.getService`
at line 141. A new `BLOCK_REASON.OWNER_MISMATCH` in
`proxy/src/challenge.js`'s sibling logic refuses **before**
`joinUpstream` (line 164) when `record.owner` (lowercased) disagrees with
`state.provider` — refusing before the URL is even used, since a squatted
`url` record is exactly what the check exists to distrust. The marketplace
listing renders such a service as contested rather than callable.

This doesn't prevent the squat — it makes it worthless, since a squatted
slug simply cannot be called or paid.

## 7 · Rendering approach

`render.js`'s existing string-based views (marketplace, provider summary,
the new how-it-works) are untouched — they work and carry no interactive
state beyond what `main.js` already re-renders wholesale. The five new
interactive surfaces (SLA editor, top-up form, retire confirmation, new
service wizard, connect/SIWE button) mount once as real DOM nodes in
`web/src/forms/*.js` and patch only their own dependent fragments (validity
message, pending/error state, wizard step) — so inputs are never destroyed
mid-edit and the existing caret-restoration hack in `main.js` goes away
entirely rather than growing a second instance.

No new dependency: this is DOM APIs directly, same zero-framework stance
`web/package.json`'s own comment states.

## 8 · Testing

- `web`: router param round-trip; SIWE session lifecycle (issue, verify,
  expiry, clear on account change); slug validation agreeing with the
  contract's regex; top-up shortfall arithmetic against `DEPOSIT_AMOUNT()`;
  wizard step derivation from mocked chain state.
- `contracts`: `VerdiktSubnameRegistrarTest` — a successful claim; claiming
  an already-claimed slug reverts; the claimant cannot call `setText` for
  `conformance`/`availability`; the claimant cannot call `setResolver` on
  their own node (role bitmap 0 holds).
- `proxy`: `OWNER_MISMATCH` blocks before any upstream `fetch`, both when the
  mismatch is real and when `record.owner` is `null` (unclaimed subname —
  falls through to the existing `NO_ADDRESS_RECORD` reasoning instead, not a
  new false block).

## Explicitly out of scope

- No backend session store — §2 is client-only by the earlier design
  decision; nothing server-side exists yet to protect.
- No contract change for reversible deactivation — `deregister` is what
  ships; a real pause is future work if ever wanted, tracked as a follow-up
  rather than folded in here (it would move the registry address and orphan
  the existing evidence transcripts).
- Discovery API wiring (`proxy` filtering on SLA clauses) stays exactly as
  unwired as `docs/Tasks.md` §5.3 already documents — untouched by this work.
