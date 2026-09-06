# Spike A — ENSv2 permissioned records on Sepolia

Answers [Tasks.md §0.2](../Tasks.md); resolves the ENSv2 entry under
[Requirements.md §10](../Requirements.md) and confirms the mechanics assumed by
[Specification.md §4](../Specification.md).

**Verdict: green. ENSv2 stays. No fallback to ENSv1's PublicResolver.**

Reproduce with `pnpm spike:ens` (29/29 checks). Run
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
parent name. `--live` covers that once both exist; it takes
`ENS_DEPLOYER_PRIVATE_KEY`, `PROVIDER_PRIVATE_KEY` and `VERIFIER_PRIVATE_KEY`,
and waits out the real commit-reveal window instead of warping time.

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

## `verdikt.eth` is not registrable on Sepolia

`ETHRegistrar.isAvailable("verdikt")` returns false. The name is in ENSv2's
`RESERVED` state — owner `0x0`, expiry `1820214744` (2027-09-02). So are
`nick` and `vitalik`, with their mainnet expiries mirrored, while an
unregistered nonsense label is available: Sepolia's ENSv2 beta premigrated
mainnet's `.eth` name set. Promotion from `RESERVED` needs
`ROLE_REGISTER_RESERVED`, held by the migration controllers, and is reachable
only by whoever owns `verdikt.eth` on mainnet.

This is a decision for [Tasks.md §0.6](../Tasks.md), not a blocker for this
spike. Either pick a parent label that is actually available on Sepolia, or
claim `verdikt.eth` on mainnet first and migrate. Until it is settled,
`ENS_PARENT_NAME` stays `verdikt.eth` in `.env.example` and the spike falls
back to `verdikt-spike.eth` for its own run, printing a `NOTE` when it does.

Nothing else depends on the choice: the parent label appears once, in
`packages/sdk/ens.js`.

## Tooling

`viem` alone, with `parseAbi` fragments taken from the deployed artifacts. No
ENS SDK and no hand-rolled ABI encoding were needed: `packetToBytes` (from
`viem/ens`) supplies the DNS encoding the `authorize*` functions want, and
`namehash` the rest. Whether the ENS JS SDK also covers this surface was not
tested — with `viem` sufficient there was nothing to gain by adding it.

The spike lives in a `scripts` workspace package so `viem` resolves without a
root-level dependency.

## One trap worth remembering

anvil's default mnemonic accounts already carry EIP-7702 delegation code on
Sepolia. That makes `to.code.length > 0` true, so the registry's ERC-1155 mint
calls `onERC1155Received` on them and reverts with `ERC1155InvalidReceiver` —
an error that points nowhere near the actual cause. The spike derives its own
signers from a Verdikt-specific string and asserts they are code-free before
doing anything else. Any future forked-Sepolia test needs the same care.

## What this unblocks

`packages/sdk/ens.js` can be implemented against the v2 backend directly; the
`ENS_BACKEND.V1` fallback stays defined but is now expected to stay unused.
The registration path above is the shape the provider-onboarding script needs.
Phases 3, 4 and 5 read through `resolveServiceRecord` unchanged.
