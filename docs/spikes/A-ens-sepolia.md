# Spike A — ENSv2 permissioned records on Sepolia

Answers [Tasks.md §0.2](../Tasks.md); resolves the ENSv2 entry under
[Requirements.md §9](../Requirements.md) and confirms the mechanics assumed by
[Specification.md §4](../Specification.md).

**Verdict: green. ENSv2 stays. No fallback to ENSv1's PublicResolver.**

Reproduce with `pnpm spike:ens` (31/31 checks). Run
`pnpm spike:ens --read-only` to check only the live-Sepolia facts, without
spawning a fork.

## What was proven

Per-key access control enforces. An address scoped to `sla` reverts with
`EACUnauthorizedAccountRoles` when it writes `conformance`, and the CRE
signer scoped to `conformance`/`availability` reverts on `sla`. That was the
whole justification for choosing ENSv2 over v1 (spec §4), and it holds.

A text record round-trips byte-identical, including non-ASCII, an embedded
newline, a quote and a backslash — the SLA JSON survives ENS unchanged, which
is what lets `evaluate` judge the same document the provider published.

The four records of a `ServiceRecord` all resolve through `UniversalResolverV2`
by name, without a caller knowing the resolver or subregistry address. A key
that was never written resolves to the empty string rather than reverting,
which is what `resolveServiceRecord`'s "missing records are `null`, not an
error" contract needs.

## How it was run

`scripts/spike-ens.mjs` defaults to **fork mode**: it spawns `anvil
--fork-url <sepolia>` and runs every step against the real deployed ENSv2
bytecode, with signers funded by `anvil_setBalance`. Fork mode was chosen over
a live run because it needs no funded key and leaves no name registered, while
still executing the same contract code a live run would — the ACL assertions
are the point of the spike, and they are decided entirely by that code.

What fork mode does *not* prove is that a live signer holds Sepolia ETH and the
parent name. `--live` covers that; it takes `ENS_DEPLOYER_PRIVATE_KEY`,
`PROVIDER_PRIVATE_KEY` and `ENS_SCORE_SIGNER_PRIVATE_KEY`, and waits out the real
commit-reveal window instead of warping time. Note that `--live` mints a real
subname and repoints records, so run `pnpm setup:ens` first and treat `--live`
as a deliberate act rather than a check.

## Deployment addresses (Sepolia, ENSv2 Beta)

From `ensdomains/contracts-v2` `contracts/deployments/sepolia/*.json`, as
rendered on [docs.ens.domains/learn/deployments](https://docs.ens.domains/learn/deployments/).
The spike asserts each has code rather than trusting the list — a beta
deployment can be redeployed under the same name.

| Contract                   | Address                                      |
| -------------------------- | -------------------------------------------- |
| `ETHRegistry`              | `0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2` |
| `ETHRegistrar`             | `0xa88553f454b77203b0d036a05c894d555eaaa2cc` |
| `RootRegistry`             | `0x8115186e8f2e0b0281e86ab91f0f48ba90364354` |
| `UniversalResolverV2`      | `0x4a1817d13e9cf196f471725176355c1234b63c70` |
| `VerifiableFactory`        | `0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef` |
| `PermissionedResolverImpl` | `0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e` |
| `UserRegistryImpl`         | `0x624a25d67b59d587752ebec8dded8827dae52050` |
| `MockUSDC`                 | `0x768f42455a2d082e23ceef7d51e5787c82d67a39` |

`PermissionedResolverImpl` and `UserRegistryImpl` are shared *implementations*,
not contracts anyone calls directly. Both are proxied per-account through the
`VerifiableFactory`.

## Mechanics the spec did not have right

Three details differ from what §4 assumes. None break the design; all change
what registration has to do.

**A subname needs a subregistry, not just a resolver.** ENSv2's registry is
hierarchical: `weather.verdikt.eth` does not exist until `verdikt.eth` points
at its own registry. So onboarding is a three-step setup, once, at
`verdikt.eth` level:

1. `VerifiableFactory.deployProxy(UserRegistryImpl, salt, initialize(owner, ALL_ROLES))`
   with `salt = keccak256(abi.encode(keccak256("UserRegistry"), namehash("verdikt.eth"), 0))`
2. `ETHRegistry.setSubregistry(labelhash, subRegistry)` and
   `ETHRegistry.setResolver(labelhash, resolver)`
3. `subRegistry.setParent(ETHRegistry, "verdikt")` — the *backward* pointer.
   `UniversalResolverV2` walks it to reconstruct the canonical name; without
   it, `resolve("weather.verdikt.eth", …)` reverts. Easy to miss, and the
   failure looks like a resolver problem rather than a wiring one.

Then each provider is one `subRegistry.register(slug, providerAddress,
address(0), resolver, roleBitmap, expiry)`.

**The resolver is per-account, not per-name.** One `PermissionedResolver`
proxy, deployed once by Verdikt, serves every `<slug>.verdikt.eth`. Salt is
`keccak256(abi.encode(keccak256("OwnedResolver"), owner, 0))`. Verdikt holds
`ROOT_RESOURCE` roles on it and delegates per-key from there.

**`authorize*` takes a DNS-encoded name; the record setters take a namehash.**
`authorizeTextRoles(dnsEncode("weather.verdikt.eth"), "sla", provider, true)`
but `setText(namehash("weather.verdikt.eth"), "sla", …)`. Two encodings of the
same name in adjacent calls; `viem`'s `packetToBytes` and `namehash` cover
both.

## Two ways to bypass the ACL, both closed by the role bitmap

The per-key ACL only holds if the provider cannot reach around it. The spike
asserts both escapes are shut, because either one silently restores the
situation ENSv1 would have left us in.

**The provider must not hold `ROLE_SET_RESOLVER` on its own subname.** With it,
a provider repoints `weather.verdikt.eth` at a resolver it fully controls and
writes whatever `conformance` it likes. So the subname is registered with a
role bitmap of `0`: the provider owns the token and nothing more. Asserted —
`setResolver` from the provider reverts.

**Provider grants must use `authorizeTextRoles`, never `authorizeNameRoles`.**
A name-level `ROLE_SET_TEXT` grant covers *every* text key on the name, the
ratios included. The spike demonstrates this positively — under a name-level
grant the provider successfully forges `conformance`, then is denied again once
it is revoked. `@verdikt/sdk` has exactly one correct call here and this is it.

## `verdikt.eth` on Sepolia

`verdikt.eth` is registered on Sepolia ENSv2, expiring 2027-09-06, and
`pnpm setup:ens` has run against it. The namespace is live:

| | |
| --- | --- |
| resolver | `0x3d411f1bA3B11B630a2405F1Fb51f088Cc2E23C9` |
| subname registry | `0x3618849F8B562DcC9D25dCbA67cF0be5C8213A97` |
| backward pointer | `(ETHRegistry, "verdikt")` |

Both proxies verify against the `VerifiableFactory` as the expected
implementations, the operator holds the resolver's root roles, and the earlier
resolver is no longer attached. So `<slug>.verdikt.eth` can now be minted, and
Tasks §0.6 has only the `verdikt.bond` DNS purchase left.

Worth recording: those two addresses are exactly the ones the fork rehearsal
predicted before anything was broadcast. The CREATE2 derivation from (factory,
sender, salt) held on live Sepolia, which is what makes the plan-then-sign flow
in `setup-ens.mjs` trustworthy rather than merely convenient.

The spike runs against the real name: on a fork it impersonates the registered
owner rather than registering a throwaway label, so the ACL assertions are made
on `verdikt.eth` itself. `pnpm spike:ens --read-only` prints live owner, expiry
and subregistry — prefer that to the table above, which is a snapshot; the name
already changed hands once during this work.

Two neighbouring facts, since they were checked and are easy to assume wrongly:

- Premigration reservations are real but they are **not** what holds
  `verdikt`. `nick` and `vitalik` are `RESERVED` (owner `0x0`, resolving
  through `ENSV1Resolver`), and a name in that state can only be promoted by
  an account holding `ROLE_REGISTER_RESERVED` — the migration controllers. The
  spike stops with that explanation if `--parent` names a reserved label.
- The reservation expiries do **not** mirror the mainnet ones. `nick` expires
  2034 on mainnet and 2027 in the Sepolia reservation; `vitalik`, 2048 and
  2068. Whatever sets them, it is not a copy.

### Resolver roles do not follow the name

The resolver is per-*account*, so transferring the ENSv2 name transfers the
token and the registry roles but **not** the resolver's `ROOT_RESOURCE` roles.
Observed live: after `verdikt.eth` moved wallets, the resolver's root roles
still sat with the previous address, which means that address could still write
every record on the name and on any subname pointed at that resolver.

For Verdikt this is a property to rely on rather than fight — the resolver
Verdikt operates is the one that must hold the root roles, independent of who
holds the name — but it has to be set deliberately. The spike now checks it:
if the resolver attached to the parent is one the deployer cannot operate, it
says so and deploys the deployer's own instead of failing seven writes later
with what looks like a broken ACL.

## Tooling

`viem` alone, with `parseAbi` fragments taken from the deployed artifacts. No
ENS SDK and no hand-rolled ABI encoding were needed: `packetToBytes` (from
`viem/ens`) supplies the DNS encoding the `authorize*` functions want, and
`namehash` the rest. Whether the ENS JS SDK also covers this surface was not
tested — with `viem` sufficient there was nothing to gain by adding it.

### Why not `ensdomains/ens-cli`

[`ens-cli`](https://github.com/ensdomains/ens-cli) covers more of this than
expected — it knows the ENSv2 Sepolia deployment, uses the same
`keccak256("OwnedResolver")` / `keccak256("UserRegistry")` salt schemes, and
generates unsigned calldata for four of `setup-ens.mjs`'s five steps
(`resolver deploy`, `resolver set`, `subregistry deploy`, `subregistry set`),
plus `subname create` and `set text`. It cannot replace these scripts:

- **`authorizeTextRoles` does not exist in it.** The string `authorize` appears
  once in the whole repository, inside a recommendation message. Its role
  vocabulary is registry-only — there is no `ROLE_SET_TEXT` and no
  resolver-level EAC at all. That is the one capability ENSv2 was chosen for.
- **`setParent` does not exist either**, so a namespace built with it alone
  would not resolve through the hierarchy.
- **`subname create` defaults the new owner's bitmap to include
  `ROLE_SET_RESOLVER`** (and its admin role). That is bypass #1 above: a
  provider onboarded with the default could repoint its own subname at a
  resolver it controls and forge `conformance`. `--role-bitmap 0` overrides it,
  but a plausible-looking default that defeats the security model is worse than
  no tool.
- It emits calldata only — no broadcasting, no fork rehearsal, and no way to
  assert a *revert reason*, which is what most of this spike consists of.

Two things were worth taking. `getState(anyId)` returns status, expiry, owner
and token id in one call, replacing four separate reads here; its results were
checked against `getStatus`/`findOwner`/`getExpiry`/`findTokenId` on Sepolia for
a REGISTERED, a RESERVED and an AVAILABLE name and agree in every field. And
all six shared ENSv2 Sepolia addresses plus both salt schemes match what ENS's
own tooling uses — an independent confirmation of constants otherwise taken
from the docs.

## Package layout

The scripts live in a `scripts` workspace package so `viem` resolves without a
root-level dependency, and share `scripts/ens-sepolia.mjs` — deployment
addresses, the ABIs both need, role constants, and the anvil helpers. It holds
only what both use; anything one script needs stays in that script.

That file is temporary in one respect. When `resolveServiceRecord` is
implemented, the read path — Universal Resolver address, resolver getter ABI,
DNS encoding — will exist both there and in `packages/sdk/ens.js`, which is
exactly the duplication the "only file that knows ENS exists" rule prevents.
The SDK should own it at that point and the scripts should import it, leaving
`ens-sepolia.mjs` the registrar/factory surface the SDK must never carry. Noted
as a checklist item in Tasks §4.5 so it is not forgotten.

## Two traps worth remembering

**A name's token id is not its labelhash.** ENSv2 token ids are mutable: the
low 32 bits are a version counter that changes on re-registration and on role
updates. So `latestOwnerOf(labelhash)` returns the zero address for a perfectly
healthy `REGISTERED` name. Read state with `getStatus(anyId)` and ownership
with `findOwner(label)` or `latestOwnerOf(findTokenId(label))` — never by
inferring a state from a zero owner. An earlier draft of this spike did exactly
that and reported `verdikt.eth` as reserved when it was registered.

**anvil's default mnemonic accounts already carry EIP-7702 delegation code on
Sepolia.** That makes `to.code.length > 0` true, so the registry's ERC-1155
mint calls `onERC1155Received` on them and reverts with
`ERC1155InvalidReceiver` — an error that points nowhere near the actual cause.
The spike derives its own signers from a Verdikt-specific string and asserts
they are code-free before doing anything else. Any future forked-Sepolia test
needs the same care.

## Setting the namespace up

`scripts/setup-ens.mjs` (`pnpm setup:ens`) turns the sequence above into the
transactions that still need sending against `verdikt.eth`: deploy a resolver
the operator controls, point the name at it, deploy the `UserRegistry`, attach
it, and set the backward pointer. Every step reads live state first and skips
what is already in place, so a re-run after a partial failure resumes.

It rehearses on an anvil fork before doing anything. In the default mode that
is all it does — it writes the resulting `to`/`data` pairs to
`ens-setup-plan.json` for signing from any wallet, and shows them abbreviated
with a byte count. The terminal deliberately does not print full calldata:
300 bytes of unbroken hex wraps and clips when copied, and a truncated copy is
still valid-looking hex that is a correct *prefix* of the real value. That
happened once in review. Take calldata from the file, or use `--send`. A `VerifiableFactory` proxy address is fixed by (factory, sender,
salt), so the addresses the rehearsal produces are the ones a live run
produces; the printed calldata was applied to a fork independently and landed
on exactly the predicted addresses, with the spike then passing 31/31 against
the result. `--send` broadcasts using `ENS_DEPLOYER_PRIVATE_KEY`, and refuses
unless that key's address is `ENS_OPERATOR_ADDRESS` — a different signer would
silently deploy a different resolver at a different address.

## What this unblocks

`packages/sdk/ens.js` can be implemented against the v2 backend directly; the
`ENS_BACKEND.V1` fallback stays defined but is now expected to stay unused.
Provider onboarding is one `subRegistry.register` plus the `authorizeTextRoles`
grants, once `pnpm setup:ens` has run. Phases 3, 4 and 5 read through
`resolveServiceRecord` unchanged.
