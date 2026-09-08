# Provider Console, Navigation & Self-Serve Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the dashboard a main menu (GitHub/X links included), a SIWE-gated provider console where a connected wallet signs its own transactions to publish an SLA, top up a bond, retire a service, and onboard a brand-new one — backed by a permissionless ENS subname registrar contract so Verdikt never holds a provider's key.

**Architecture:** A new `VerdiktSubnameRegistrar` contract on Sepolia does in one permissionless `claim()` call what `scripts/onboard-service.mjs` today does as four operator-run transactions. The dashboard gains a wallet/SIWE layer (`web/src/wallet.js`, `web/src/session.js`) and a thin actions layer (`web/src/actions.js`) that sends real transactions through the connected wallet; existing read paths (`packages/sdk/ens.js`, `web/src/marketplace.js`) gain one new fact — the ENS subname's owner — so the proxy can refuse to route a slug whose Arc and ENS claims disagree.

**Tech Stack:** Solidity ^0.8.24 / Foundry (contracts), viem 2.56.3 (SDK, scripts, web — including `viem/siwe`), vanilla DOM (web, no framework), Vitest.

## Global Constraints

- No blank lines inside function bodies for visual separation (user's global JS/TS guide).
- ESM throughout; ambient `*.d.ts` files carry no `export` (CLAUDE.md "Conventions").
- `proxy` must never depend on `@verdikt/sla` (CLAUDE.md package boundary).
- `packages/sdk/ens.js` is the only file that knows ENS exists; every ENS-touching read/write in `web`/`proxy` goes through it or through `packages/sdk/deployments.js`'s `SEPOLIA`/`ARC` constants — no other file hardcodes an ENSv2 address.
- One slug is three identifiers (Arc `serviceId`, `<slug>.verdikt.bond` route, `<slug>.verdikt.eth` subname) — slug validation must stay byte-for-byte identical everywhere it is checked (`VerdiktRegistry._assertValidSlug`, `packages/sdk/registry.js`'s `SLUG` regex, `proxy/src/router.js`'s `SLUG` regex, and the new `VerdiktSubnameRegistrar._assertValidSlug`).
- `forge fmt --check` is enforced in CI — run `forge fmt` on every Solidity file before committing.
- Never put a value in `web/.env.local`/`web/wrangler.jsonc` `vars` that isn't safe to ship in a public bundle; provider write paths use the connected wallet's own RPC, never a Verdikt-held key.
- Outcome/Status ordinals and event ABI copies are load-bearing mirrors (CLAUDE.md "Invariants that are easy to break") — this plan adds no new ordinal or event-shape duplication, so this constraint is inherited, not touched.
- Commit after every task with a working, tested state. Use short, non-itemized commit messages (user's global git guide).

---

## File Map

**New files:**
- `contracts/src/DnsEncode.sol` — DNS wire-format encoding library
- `contracts/test/DnsEncode.t.sol`
- `contracts/src/VerdiktSubnameRegistrar.sol` — the permissionless onboarding contract
- `contracts/test/VerdiktSubnameRegistrar.t.sol`
- `contracts/script/DeployRegistrar.s.sol` — Foundry deploy script
- `scripts/grant-registrar-roles.mjs` — one-time operator role grants (plan-then-sign, like `setup-ens.mjs`)
- `web/src/wallet.js` — EIP-6963 wallet discovery + viem wallet client + chain switching
- `web/src/wallet.test.js`
- `web/src/session.js` — SIWE sign-in, verified in-browser, persisted with expiry
- `web/src/session.test.js`
- `web/src/router.js` — URL `?view=`/`?service=`/`?provider=` read/write
- `web/src/router.test.js`
- `web/src/actions.js` — the six provider write calls
- `web/src/actions.test.js`
- `web/src/nav.js` — masthead navigation + GitHub/X icons
- `web/src/views/how-it-works.js` — static explainer view
- `web/src/forms/sla-editor.js` — DOM-mounted SLA publish form
- `web/src/forms/sla-editor.test.js`
- `web/src/forms/bond.js` — DOM-mounted top-up/retire forms
- `web/src/forms/bond.test.js`
- `web/src/forms/wizard.js` — DOM-mounted 3-step onboarding wizard

**Modified files:**
- `contracts/src/EnsNamehash.sol` — no change (reused as-is)
- `scripts/ens-sepolia.mjs` — add `grantRootRoles` ABI fragments + `REGISTRY_ROLE_REGISTRAR`
- `packages/sdk/ens.js` — `ServiceRecord.owner`, `subnameRegistryAbi`
- `packages/sdk/ens.test.js` — cover the new `owner` field
- `packages/sdk/types.d.ts` — `ServiceRecord.owner`
- `fixtures/index.js` — `SERVICE_RECORD.owner: null`
- `deployments/sepolia.json` — `subnameRegistrar: null` placeholder key
- `proxy/src/challenge.js` — `checkOwnership`, `BLOCK_REASON.OWNER_MISMATCH`
- `proxy/src/router.js` — wire the ownership check in before routing
- `proxy/src/router.test.js` — cover the new refusal
- `web/src/marketplace.js` — `Listing.contested`
- `web/src/marketplace.test.js` — cover `contested`
- `web/src/source.js` — demo `owner` fields matching demo providers
- `web/types.d.ts` — `Listing.contested`
- `web/src/render.js` — nav mount point, contested aside, provider console rewrite (forms instead of read-only calldata table), how-it-works route
- `web/src/main.js` — router-driven view switching, wallet/session wiring, mounts forms instead of full re-render for interactive regions
- `web/src/styles.css` — nav, buttons, form controls, wizard steps
- `web/package.json` — add `viem` as a direct dependency
- `web/index.html` — no structural change expected (mount point already `#app`)

---

### Task 1: `DnsEncode` library

**Files:**
- Create: `contracts/src/DnsEncode.sol`
- Test: `contracts/test/DnsEncode.t.sol`

**Interfaces:**
- Produces: `DnsEncode.dnsEncode(string memory name) internal pure returns (bytes memory)`, errors `EmptyName()`, `EmptyLabel(string name)`, `UnnormalisedName(string name)`, `LabelTooLong(string name)`.

- [ ] **Step 1: Write the failing test**

Create `contracts/test/DnsEncode.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DnsEncode} from "../src/DnsEncode.sol";

/// @dev Every expected value here was computed by viem's `packetToBytes` — the
///      same implementation `packages/sdk/ens.js`'s `dnsEncode` and
///      `scripts/ens-sepolia.mjs` use. `VerdiktSubnameRegistrar` calls
///      `authorizeTextRoles` with exactly this encoding, so a divergence here
///      would grant roles under a name the real resolver never resolves to.
contract DnsEncodeTest is Test {
    function test_matchesViemOnTheNamesVerdiktUses() public pure {
        assertEq(DnsEncode.dnsEncode("verdikt.eth"), hex"0776657264696b740365746800");
        assertEq(DnsEncode.dnsEncode("weather.verdikt.eth"), hex"07776561746865720776657264696b740365746800");
    }

    function test_matchesViemOnTheStructuralCases() public pure {
        assertEq(DnsEncode.dnsEncode("eth"), hex"0365746800");
        // Three labels, to prove the general loop rather than a two-label special case.
        assertEq(DnsEncode.dnsEncode("a.b.c"), hex"01610162016300");
    }

    function test_refusesNamesItCannotFaithfullyEncode() public {
        string[4] memory unnormalised = ["Verdikt.eth", "VERDIKT.ETH", unicode"vérdikt.eth", "verdikt_x.eth"];
        for (uint256 i = 0; i < unnormalised.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(DnsEncode.UnnormalisedName.selector, unnormalised[i]));
            this.dnsEncode(unnormalised[i]);
        }
    }

    function test_refusesEmptyLabels() public {
        string[3] memory malformed = [".eth", "verdikt.", "verdikt..eth"];
        for (uint256 i = 0; i < malformed.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(DnsEncode.EmptyLabel.selector, malformed[i]));
            this.dnsEncode(malformed[i]);
        }
    }

    function test_refusesTheEmptyName() public {
        vm.expectRevert(DnsEncode.EmptyName.selector);
        this.dnsEncode("");
    }

    /// @dev A DNS label cannot exceed 63 bytes; a slug is capped at 63 by
    ///      `VerdiktRegistry`, but the parent name is deploy-time input and
    ///      deserves the same guard rather than silently truncating.
    function test_refusesALabelOver63Bytes() public {
        string memory label64 = _repeat("a", 64);
        string memory name = string.concat(label64, ".eth");
        vm.expectRevert(abi.encodeWithSelector(DnsEncode.LabelTooLong.selector, name));
        this.dnsEncode(name);
    }

    function _repeat(bytes1 c, uint256 n) private pure returns (string memory) {
        bytes memory buf = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            buf[i] = c;
        }
        return string(buf);
    }

    /// @dev `vm.expectRevert` needs an external call to observe.
    function dnsEncode(string calldata name) external pure returns (bytes memory) {
        return DnsEncode.dnsEncode(name);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts && forge test --match-contract DnsEncodeTest`
Expected: FAIL — `DnsEncode.sol` does not exist yet (compile error).

- [ ] **Step 3: Write the implementation**

Create `contracts/src/DnsEncode.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DnsEncode
/// @notice DNS wire-format encoding (RFC 1035 §3.1) for a normalised
///         dot-separated name — what ENSv2's `authorizeTextRoles` and
///         `authorizeNameRoles` take as `toName`, alongside `EnsNamehash`'s
///         namehash for the same name (Spike A: "`authorize*` takes a
///         DNS-encoded name; the record setters take a namehash").
///
/// @dev Deploy-time only, same as `EnsNamehash`: `VerdiktSubnameRegistrar`
///      encodes its immutable parent name once in its constructor and reuses
///      it per `claim`, rather than re-parsing a dotted string on every call.
///
///      Shares `EnsNamehash`'s normalisation rule rather than importing a
///      helper from it: UTS-46 folding is not implementable in Solidity at any
///      sensible cost, so both libraries accept only lowercase ASCII letters,
///      digits, hyphens and single dots, for which normalisation is the
///      identity function. Anything else reverts rather than encoding a name
///      that resolves to nothing.
library DnsEncode {
    error EmptyName();
    error EmptyLabel(string name);
    error UnnormalisedName(string name);
    error LabelTooLong(string name);

    /// @param name e.g. "verdikt.eth". Must already be normalised — see above.
    /// @return encoded length-prefixed labels terminated by a zero byte, e.g.
    ///         `verdikt.eth` -> `0x07 "verdikt" 0x03 "eth" 0x00`.
    function dnsEncode(string memory name) internal pure returns (bytes memory encoded) {
        bytes memory raw = bytes(name);
        if (raw.length == 0) revert EmptyName();
        _assertNormalised(raw, name);

        // Every dot becomes a length byte and vanishes; one more length byte
        // covers the final label, and one terminator ends the name. Net: two
        // bytes longer than the input, regardless of how many labels there are.
        encoded = new bytes(raw.length + 2);
        uint256 out = 0;
        uint256 labelStart = 0;
        for (uint256 i = 0; i <= raw.length; ++i) {
            if (i == raw.length || raw[i] == ".") {
                uint256 labelLength = i - labelStart;
                encoded[out] = bytes1(uint8(labelLength));
                out += 1;
                for (uint256 j = 0; j < labelLength; ++j) {
                    encoded[out] = raw[labelStart + j];
                    out += 1;
                }
                labelStart = i + 1;
            }
        }
        encoded[out] = 0x00;
    }

    /// @dev Same allowlist as `EnsNamehash._assertNormalised`, plus a label
    ///      length bound `EnsNamehash` does not need: a namehash of an
    ///      over-long label is still well-formed, but DNS wire format is not.
    function _assertNormalised(bytes memory raw, string memory name) private pure {
        if (raw[0] == "." || raw[raw.length - 1] == ".") revert EmptyLabel(name);
        uint256 labelStart = 0;
        for (uint256 i = 0; i < raw.length; ++i) {
            bytes1 c = raw[i];
            bool ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-" || c == ".";
            if (!ok) revert UnnormalisedName(name);
            if (c == ".") {
                if (i > 0 && raw[i - 1] == ".") revert EmptyLabel(name);
                if (i - labelStart > 63) revert LabelTooLong(name);
                labelStart = i + 1;
            }
        }
        if (raw.length - labelStart > 63) revert LabelTooLong(name);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd contracts && forge test --match-contract DnsEncodeTest -vv`
Expected: PASS, 6 tests.

- [ ] **Step 5: Format and commit**

```bash
cd contracts && forge fmt src/DnsEncode.sol test/DnsEncode.t.sol
cd .. && git add contracts/src/DnsEncode.sol contracts/test/DnsEncode.t.sol
git commit -m "Add a DNS wire-format encoding library for contracts"
```

---

### Task 2: `VerdiktSubnameRegistrar` contract

**Files:**
- Create: `contracts/src/VerdiktSubnameRegistrar.sol`
- Test: `contracts/test/VerdiktSubnameRegistrar.t.sol`

**Interfaces:**
- Consumes: `DnsEncode.dnsEncode` (Task 1), `EnsNamehash.namehash` (existing, `contracts/src/EnsNamehash.sol`).
- Produces: `VerdiktSubnameRegistrar.claim(string calldata slug, address payTo) external returns (bytes32 node)`; `dnsNameFor(string calldata slug) external view returns (bytes memory)`; public immutables `SUBNAME_REGISTRY`, `RESOLVER`, `SCORE_WRITER`, `PARENT_NODE`, `DURATION_SECONDS`; event `SubnameClaimed(string slug, bytes32 indexed node, address indexed claimant, address payTo)`.

- [ ] **Step 1: Write the failing test**

Create `contracts/test/VerdiktSubnameRegistrar.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VerdiktSubnameRegistrar} from "../src/VerdiktSubnameRegistrar.sol";
import {EnsNamehash} from "../src/EnsNamehash.sol";

/// @dev Mirrors `PermissionedRegistry.register`'s two invariants under test:
///      double-registration reverts, and the role bitmap actually granted is
///      recorded so a test can assert it was zero — mirrors the pattern
///      `VerdiktScoreWriter.t.sol`'s `ResolverStub` already uses: "records what
///      the real contract would have stored, and refuses what it would refuse."
contract RegistryStub {
    struct Entry {
        address owner;
        address resolver;
        uint256 roleBitmap;
        uint64 expiry;
        bool registered;
    }

    mapping(bytes32 => Entry) public entries;

    error LabelAlreadyRegistered(string label);
    error Unauthorized();

    function register(string calldata label, address owner, address, address resolver, uint256 roleBitmap, uint64 expiry)
        external
        returns (uint256)
    {
        bytes32 id = keccak256(bytes(label));
        if (entries[id].registered) revert LabelAlreadyRegistered(label);
        entries[id] = Entry(owner, resolver, roleBitmap, expiry, true);
        return uint256(id);
    }

    /// @dev Stands in for `PermissionedRegistry.setResolver`'s `ROLE_SET_RESOLVER`
    ///      gate: bit 0 of the stub's role bitmap stands for that role. Real
    ///      ENSv2 uses nybble 6 (`1 << 24`); the exact bit does not matter here
    ///      — what matters is that role bitmap 0 (what `claim` passes) holds
    ///      none of it, on any bit.
    function setResolver(string calldata label, address newResolver) external {
        bytes32 id = keccak256(bytes(label));
        Entry storage e = entries[id];
        if (e.owner != msg.sender) revert Unauthorized();
        if (e.roleBitmap == 0) revert Unauthorized();
        e.resolver = newResolver;
    }
}

/// @dev Records exactly which key was granted to which account for which
///      encoded name, so a test can assert `sla`/`url` went to the claimant
///      and `conformance`/`availability` went to the score writer — never
///      the reverse.
contract ResolverStub {
    mapping(bytes32 => mapping(bytes32 => mapping(address => bool))) public textGrant;
    mapping(bytes32 => address) public addrOf;

    function authorizeTextRoles(bytes calldata toName, string calldata key, address account, bool grant)
        external
        returns (bool)
    {
        textGrant[keccak256(toName)][keccak256(bytes(key))][account] = grant;
        return true;
    }

    function setAddr(bytes32 node, address addr_) external {
        addrOf[node] = addr_;
    }
}

contract VerdiktSubnameRegistrarTest is Test {
    string internal constant PARENT_NAME = "verdikt.eth";
    uint64 internal constant DURATION = 365 days;

    RegistryStub internal registry;
    ResolverStub internal resolver;
    address internal scoreWriter = makeAddr("scoreWriter");
    address internal claimant = makeAddr("claimant");
    address internal payTo = makeAddr("payTo");

    VerdiktSubnameRegistrar internal registrar;

    function setUp() public {
        registry = new RegistryStub();
        resolver = new ResolverStub();
        registrar = new VerdiktSubnameRegistrar(address(registry), address(resolver), scoreWriter, PARENT_NAME, DURATION);
    }

    function _node(string memory slug) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(EnsNamehash.namehash(PARENT_NAME), keccak256(bytes(slug))));
    }

    function test_registersWithRoleBitmapZero() public {
        vm.prank(claimant);
        registrar.claim("weather", payTo);

        (address owner,, uint256 roleBitmap,, bool registered) = registry.entries(keccak256("weather"));
        assertTrue(registered);
        assertEq(owner, claimant);
        assertEq(roleBitmap, 0);
    }

    /// @dev Positive assertion, not just "roleBitmap == 0": proves the zero
    ///      bitmap actually blocks `setResolver` the way Spike A's live
    ///      assertion does — bypass #1 stays closed.
    function test_claimantCannotRepointItsOwnResolver() public {
        vm.prank(claimant);
        registrar.claim("weather", payTo);

        vm.prank(claimant);
        vm.expectRevert(RegistryStub.Unauthorized.selector);
        registry.setResolver("weather", address(0xBAD));
    }

    function test_setsExpiryDurationSecondsOut() public {
        vm.warp(1_000_000);
        vm.prank(claimant);
        registrar.claim("weather", payTo);
        (,,, uint64 expiry,) = registry.entries(keccak256("weather"));
        assertEq(expiry, 1_000_000 + DURATION);
    }

    function test_grantsSlaAndUrlToTheClaimantOnly() public {
        bytes memory dnsName = registrar.dnsNameFor("weather");
        vm.prank(claimant);
        registrar.claim("weather", payTo);

        assertTrue(resolver.textGrant(keccak256(dnsName), keccak256("sla"), claimant));
        assertTrue(resolver.textGrant(keccak256(dnsName), keccak256("url"), claimant));
        // Never to the claimant — this is the whole ACL argument for ENSv2.
        assertFalse(resolver.textGrant(keccak256(dnsName), keccak256("conformance"), claimant));
        assertFalse(resolver.textGrant(keccak256(dnsName), keccak256("availability"), claimant));
    }

    function test_grantsConformanceAndAvailabilityToTheScoreWriterOnly() public {
        bytes memory dnsName = registrar.dnsNameFor("weather");
        vm.prank(claimant);
        registrar.claim("weather", payTo);

        assertTrue(resolver.textGrant(keccak256(dnsName), keccak256("conformance"), scoreWriter));
        assertTrue(resolver.textGrant(keccak256(dnsName), keccak256("availability"), scoreWriter));
        assertFalse(resolver.textGrant(keccak256(dnsName), keccak256("sla"), scoreWriter));
        assertFalse(resolver.textGrant(keccak256(dnsName), keccak256("url"), scoreWriter));
    }

    function test_setsTheAddressRecordToPayTo() public {
        vm.prank(claimant);
        registrar.claim("weather", payTo);
        assertEq(resolver.addrOf(_node("weather")), payTo);
    }

    function test_emitsSubnameClaimed() public {
        vm.expectEmit(true, true, false, true, address(registrar));
        emit VerdiktSubnameRegistrar.SubnameClaimed("weather", _node("weather"), claimant, payTo);
        vm.prank(claimant);
        registrar.claim("weather", payTo);
    }

    function test_revertsOnAnAlreadyClaimedSlug() public {
        vm.prank(claimant);
        registrar.claim("weather", payTo);

        vm.expectRevert(abi.encodeWithSelector(RegistryStub.LabelAlreadyRegistered.selector, "weather"));
        vm.prank(makeAddr("mallory"));
        registrar.claim("weather", makeAddr("elsewhere"));
    }

    function test_revertsOnAZeroPayTo() public {
        vm.prank(claimant);
        vm.expectRevert(VerdiktSubnameRegistrar.ZeroPayTo.selector);
        registrar.claim("weather", address(0));
    }

    /// @dev Must reject exactly what `VerdiktRegistry._assertValidSlug` rejects
    ///      — one slug is also the Arc serviceId, so the two must agree.
    function test_rejectsSlugsTheArcRegistryWouldReject() public {
        string[4] memory bad = ["", "Weather", "-weather", "weather-"];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert();
            vm.prank(claimant);
            registrar.claim(bad[i], payTo);
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contracts && forge test --match-contract VerdiktSubnameRegistrarTest`
Expected: FAIL — `VerdiktSubnameRegistrar.sol` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `contracts/src/VerdiktSubnameRegistrar.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DnsEncode} from "./DnsEncode.sol";
import {EnsNamehash} from "./EnsNamehash.sol";

interface ISubnameRegistry {
    function register(
        string calldata label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256);
}

interface IAuthorizingResolver {
    function authorizeTextRoles(bytes calldata toName, string calldata key, address account, bool grant)
        external
        returns (bool);
    function setAddr(bytes32 node, address addr_) external;
}

/// @title VerdiktSubnameRegistrar
/// @notice Permissionless `<slug>.verdikt.eth` onboarding (Specification.md §4,
///         Tasks.md 5.3 stretch 1 — provider self-serve).
///
/// @dev **Why this contract can do what only the operator could do before.**
///      `scripts/onboard-service.mjs` mints a subname, grants `sla`/`url` to
///      the provider and `conformance`/`availability` to the score writer, and
///      sets the address record — four EAC-gated calls, run by a human holding
///      the `verdikt.eth` operator key. Verified against the live Sepolia
///      bytecode (Sourcify, chain 11155111): `PermissionedRegistry.register`
///      requires `ROLE_REGISTRAR` at `ROOT_RESOURCE` (`RegistryRolesLib.sol`),
///      and `PermissionedResolver.authorizeTextRoles`/`setAddr` resolve
///      through `EnhancedAccessControl`'s root-resource fallback — an account
///      holding a role at `ROOT_RESOURCE` holds it on every name. So a
///      contract granted those same two root roles (once, by the operator, via
///      `scripts/grant-registrar-roles.mjs`) can run the onboarding sequence
///      for any slug, for anyone, without holding a key of theirs and without
///      a human in the loop.
///
///      **The two ACL bypasses Spike A found stay closed.** Role bitmap `0` for
///      the claimant — never `ROLE_SET_RESOLVER`, which would let a provider
///      repoint its own subname at a resolver it controls and forge
///      `conformance`. Per-key `authorizeTextRoles`, never name-wide
///      `authorizeNameRoles`, which would grant the provider every text key at
///      once, ratios included.
///
///      **What this contract cannot do.** It cannot write `sla`, `url`,
///      `conformance` or `availability` itself — it only grants the *roles* to
///      write them, to the claimant and the score writer respectively. It never
///      touches Arc: registering the service there is a separate transaction
///      the claimant signs themselves against `VerdiktRegistry.register`, and
///      the proxy refuses to route a slug whose ENS owner and Arc provider
///      disagree (`proxy/src/challenge.js`'s `checkOwnership`) — a claim here
///      with no matching Arc registration is inert, not a working service.
contract VerdiktSubnameRegistrar {
    ISubnameRegistry public immutable SUBNAME_REGISTRY;
    IAuthorizingResolver public immutable RESOLVER;
    address public immutable SCORE_WRITER;
    bytes32 public immutable PARENT_NODE;
    uint64 public immutable DURATION_SECONDS;

    /// @dev Set once in the constructor from `parentName`. Not `immutable`:
    ///      Solidity immutables are value types only, and DNS wire format is
    ///      dynamic `bytes`. `claim` reads it once per call — not a hot path.
    bytes private _parentDnsSuffix;

    error EmptySlug();
    error InvalidSlug(string slug);
    error ZeroPayTo();

    /// @notice A slug was claimed: subname minted, `sla`/`url` granted to the
    ///         claimant, `conformance`/`availability` granted to the score
    ///         writer, and the address record set to `payTo`.
    event SubnameClaimed(string slug, bytes32 indexed node, address indexed claimant, address payTo);

    constructor(
        address subnameRegistry,
        address resolver,
        address scoreWriter,
        string memory parentName,
        uint64 durationSeconds
    ) {
        require(subnameRegistry != address(0), "subnameRegistry=0");
        require(resolver != address(0), "resolver=0");
        require(scoreWriter != address(0), "scoreWriter=0");
        require(durationSeconds > 0, "duration=0");
        SUBNAME_REGISTRY = ISubnameRegistry(subnameRegistry);
        RESOLVER = IAuthorizingResolver(resolver);
        SCORE_WRITER = scoreWriter;
        PARENT_NODE = EnsNamehash.namehash(parentName);
        DURATION_SECONDS = durationSeconds;
        _parentDnsSuffix = DnsEncode.dnsEncode(parentName);
    }

    /// @notice Claim `<slug>.verdikt.eth`: mint it to the caller with no
    ///         resolver control, grant per-key write access, and set the
    ///         payout address.
    /// @dev Reverts with the registry's own `LabelAlreadyRegistered` if the
    ///      slug is taken — nothing here needs to re-check that first.
    /// @param slug the label. Same charset `VerdiktRegistry._assertValidSlug`
    ///        enforces, since one slug is also the Arc serviceId.
    /// @param payTo the address a payer's x402 payment should reach. Usually
    ///        `msg.sender`, but kept separate so a claimant can route payment
    ///        to a different wallet without controlling the subname from it.
    /// @return node the subname's ENS namehash.
    function claim(string calldata slug, address payTo) external returns (bytes32 node) {
        _assertValidSlug(slug);
        if (payTo == address(0)) revert ZeroPayTo();

        bytes memory dnsName = _dnsNameFor(slug);
        node = keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(slug))));

        // Role bitmap 0: the claimant gets the token and nothing else — never
        // ROLE_SET_RESOLVER (Spike A bypass #1).
        SUBNAME_REGISTRY.register(
            slug, msg.sender, address(0), address(RESOLVER), 0, uint64(block.timestamp) + DURATION_SECONDS
        );

        // Per key, never name-wide (Spike A bypass #2).
        RESOLVER.authorizeTextRoles(dnsName, "sla", msg.sender, true);
        RESOLVER.authorizeTextRoles(dnsName, "url", msg.sender, true);
        RESOLVER.authorizeTextRoles(dnsName, "conformance", SCORE_WRITER, true);
        RESOLVER.authorizeTextRoles(dnsName, "availability", SCORE_WRITER, true);
        RESOLVER.setAddr(node, payTo);

        emit SubnameClaimed(slug, node, msg.sender, payTo);
    }

    /// @notice The DNS wire-format name `authorizeTextRoles` takes for
    ///         `slug.<parentName>`. Exposed so a caller — or a test — can
    ///         recompute the exact bytes `claim` used, without re-deriving the
    ///         encoding itself.
    function dnsNameFor(string calldata slug) external view returns (bytes memory) {
        _assertValidSlug(slug);
        return _dnsNameFor(slug);
    }

    function _dnsNameFor(string calldata slug) private view returns (bytes memory) {
        bytes calldata raw = bytes(slug);
        return abi.encodePacked(bytes1(uint8(raw.length)), raw, _parentDnsSuffix);
    }

    /// @dev Mirrors `VerdiktRegistry._assertValidSlug` exactly: one slug is
    ///      also the Arc serviceId, so a slug this accepts must be exactly the
    ///      one Arc registration would accept too.
    function _assertValidSlug(string calldata slug) private pure {
        bytes calldata raw = bytes(slug);
        if (raw.length == 0) revert EmptySlug();
        if (raw.length > 63) revert InvalidSlug(slug);
        if (raw[0] == "-" || raw[raw.length - 1] == "-") revert InvalidSlug(slug);
        for (uint256 i = 0; i < raw.length; ++i) {
            bytes1 c = raw[i];
            bool ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-";
            if (!ok) revert InvalidSlug(slug);
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd contracts && forge test --match-contract VerdiktSubnameRegistrarTest -vv`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the full contracts suite to confirm nothing else broke**

Run: `cd contracts && forge build && forge test`
Expected: PASS, all existing suites plus the two new ones green.

- [ ] **Step 6: Format and commit**

```bash
cd contracts && forge fmt src/VerdiktSubnameRegistrar.sol test/VerdiktSubnameRegistrar.t.sol
cd .. && git add contracts/src/VerdiktSubnameRegistrar.sol contracts/test/VerdiktSubnameRegistrar.t.sol
git commit -m "Add a permissionless ENS subname registrar for provider self-serve onboarding"
```

---

### Task 3: Deploy script and operator role-grant script

**Files:**
- Create: `contracts/script/DeployRegistrar.s.sol`
- Modify: `scripts/ens-sepolia.mjs` (add `grantRootRoles` ABI fragments + `REGISTRY_ROLE_REGISTRAR`)
- Create: `scripts/grant-registrar-roles.mjs`
- Modify: `deployments/sepolia.json` (add `subnameRegistrar: null`)

**Interfaces:**
- Consumes: `VerdiktSubnameRegistrar` (Task 2), `SEPOLIA` from `packages/sdk/deployments.js`, `RESOLVER_ROLES_VERDIKT_NEEDS` (existing, `scripts/ens-sepolia.mjs`).
- Produces: `deployments/sepolia.json`'s `subnameRegistrar` key (filled in by whoever runs the deploy script against live Sepolia — not run in this task, since it needs a funded operator key); `scripts/grant-registrar-roles.mjs` (plan-then-sign, `--send` to broadcast).

This task has no automated test — deploying a contract and granting live-chain roles is an operational script, the same category as `setup-ens.mjs`/`onboard-service.mjs`, neither of which has a unit test either (they are exercised against a fork by `pnpm spike:ens`, or live with `--send`). Correctness here is: it compiles, the dry-run output is right, and it mirrors the idempotent read-first pattern the sibling scripts already use.

- [ ] **Step 1: Add `subnameRegistrar: null` to `deployments/sepolia.json`**

Edit `deployments/sepolia.json`, adding a new top-level key after `scoreWriter` (mirrors how `ARC.registry` starts `null` per its own comment: "Verdikt's Arc deployment. `registry` is null until Tasks.md 2.4 unblocks"):

```json
  "scoreWriter": "0x542cb024d71e0cd0ef40ab7603779c89895effaa",
  "$subnameRegistrar": "VerdiktSubnameRegistrar, deployed by contracts/script/DeployRegistrar.s.sol. Null until deployed and granted ROLE_REGISTRAR on the subname registry and RESOLVER_ROLES_VERDIKT_NEEDS on the resolver by scripts/grant-registrar-roles.mjs — see that script's header for the exact sequence.",
  "subnameRegistrar": null
```

- [ ] **Step 2: Write `contracts/script/DeployRegistrar.s.sol`**

Mirrors `contracts/script/DeployScoreWriter.s.sol` exactly in structure:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {VerdiktSubnameRegistrar} from "../src/VerdiktSubnameRegistrar.sol";

/// @notice Deploys VerdiktSubnameRegistrar to Ethereum Sepolia (Tasks.md 5.3
///         stretch 1 — provider self-serve onboarding).
///
/// @dev Usage:
///
///      forge script script/DeployRegistrar.s.sol:DeployRegistrar \
///        --rpc-url sepolia --broadcast
///
///      Environment:
///        DEPLOYER_PRIVATE_KEY  — funded with Sepolia ETH. Does NOT need to be
///                                the `verdikt.eth` operator key — deploying
///                                the contract needs no ENS role at all.
///        SUBNAME_DURATION_SECONDS — optional. Defaults to 365 days, same as
///                                `scripts/onboard-service.mjs`'s onboarding.
///
///      The subname registry, resolver, score writer and parent name are NOT
///      environment variables: they are Verdikt's own Sepolia deployment, read
///      from `deployments/sepolia.json`, the same file the SDK and the ENS
///      scripts read — a second, independently-set source for values already
///      recorded there could only ever disagree with it.
///
///      **Deployment is not finished when this returns.** The contract can
///      only run `claim()` once the operator has granted it:
///
///        subnameRegistry.grantRootRoles(ROLE_REGISTRAR, registrar)
///        resolver.grantRootRoles(RESOLVER_ROLES_VERDIKT_NEEDS, registrar)
///
///      Run `node scripts/grant-registrar-roles.mjs --send` after this, then
///      paste the printed address into `deployments/sepolia.json`'s
///      `subnameRegistrar` — this script does not write that file itself, the
///      same way `DeployScoreWriter` does not write `scoreWriter` itself.
contract DeployRegistrar is Script {
    function run() external returns (VerdiktSubnameRegistrar registrar) {
        uint64 durationSeconds = uint64(vm.envOr("SUBNAME_DURATION_SECONDS", uint256(365 days)));

        string memory deployment = vm.readFile("../deployments/sepolia.json");
        address subnameRegistry = vm.parseJsonAddress(deployment, ".ens.subnameRegistry");
        address resolver = vm.parseJsonAddress(deployment, ".ens.resolver");
        address scoreWriter = vm.parseJsonAddress(deployment, ".scoreWriter");
        string memory parentName = vm.parseJsonString(deployment, ".ens.parentName");

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        registrar = new VerdiktSubnameRegistrar(subnameRegistry, resolver, scoreWriter, parentName, durationSeconds);
        vm.stopBroadcast();

        console.log("VerdiktSubnameRegistrar:", address(registrar));
        console.log("subnameRegistry:        ", subnameRegistry);
        console.log("resolver:                ", resolver);
        console.log("scoreWriter:             ", scoreWriter);
        console.log("parent:                  ", parentName);
        console.log("");
        console.log("NOT DONE YET: run `node scripts/grant-registrar-roles.mjs --send` to");
        console.log("grant this address ROLE_REGISTRAR and the resolver's root roles, then");
        console.log("record its address in deployments/sepolia.json as subnameRegistrar.");
    }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd contracts && forge build`
Expected: compiles clean (this is a script, not run against a live RPC in this task — no funded key is available in this environment; deploying is left as the documented operational step above).

- [ ] **Step 4: Add `grantRootRoles` ABI fragments and the registrar role constant to `scripts/ens-sepolia.mjs`**

Read `scripts/ens-sepolia.mjs` around its `registryAbi`/`resolverAbi`/role-constant definitions first (they are at the top of the file, per Task 3's earlier research). Add `grantRootRoles` to both ABI arrays and a new role constant next to `RESOLVER_ROLES_VERDIKT_NEEDS`:

In the `registryAbi` `parseAbi([...])` array, add this line (alongside the existing `initialize`/`getState` fragments):
```js
  'function grantRootRoles(uint256 roleBitmap, address account) returns (bool)',
```

In the `resolverAbi` array's `parseAbi([...])` block (alongside `authorizeTextRoles`/`hasRootRoles`), add the same line:
```js
  'function grantRootRoles(uint256 roleBitmap, address account) returns (bool)',
```

Next to the existing `RESOLVER_ROLES_VERDIKT_NEEDS` constant, add:
```js
/**
 * `PermissionedRegistry`'s `RegistryRolesLib.ROLE_REGISTRAR` — nybble 0,
 * root-only. What `VerdiktSubnameRegistrar` needs on the subname registry to
 * call `register()` on a claimant's behalf (verified against the live Sepolia
 * bytecode via Sourcify — `RegistryRolesLib.sol`).
 */
export const REGISTRY_ROLE_REGISTRAR = 1n << 0n;
```

- [ ] **Step 5: Write `scripts/grant-registrar-roles.mjs`**

Mirrors `onboard-service.mjs`'s plan/`--send` idiom, and reads current roles first so a re-run after a partial failure resumes (same idempotency discipline as `setup-ens.mjs`):

```js
#!/usr/bin/env node
// One-time role grant for VerdiktSubnameRegistrar (Tasks.md 5.3 stretch 1).
//
// WHAT THIS DOES
//
// After `DeployRegistrar.s.sol` deploys the contract, it holds no roles yet —
// it cannot call `claim()` successfully until the operator grants it exactly
// the two root roles `onboard-service.mjs`'s human operator already exercises
// today: ROLE_REGISTRAR on the subname registry (so it can call `register()`
// on a claimant's behalf) and RESOLVER_ROLES_VERDIKT_NEEDS on the resolver (so
// it can call `authorizeTextRoles` and `setAddr`). Verified against the live
// Sepolia bytecode via Sourcify — see VerdiktSubnameRegistrar.sol's own
// header for the exact chain of reasoning.
//
// Both grants are idempotent: `hasRootRoles` is checked first and a role
// already held is not re-granted, so a re-run after a partial failure resumes
// rather than reverts — same discipline as `setup-ens.mjs`.
//
//   node scripts/grant-registrar-roles.mjs             # plan, dry run
//   node scripts/grant-registrar-roles.mjs --send       # broadcast to Sepolia
//
// Environment:
//   ENS_DEPLOYER_PRIVATE_KEY — the verdikt.eth operator key. The same key
//                              onboard-service.mjs and setup-ens.mjs use.
//   SEPOLIA_RPC_URL           — optional, defaults to the SDK's public RPC.

import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { SEPOLIA } from '@verdikt/sdk/deployments';
import {
  DEFAULT_SEPOLIA_RPC,
  REGISTRY_ROLE_REGISTRAR,
  RESOLVER_ROLES_VERDIKT_NEEDS,
  registryAbi,
  resolverAbi
} from './ens-sepolia.mjs';

function parseArgs(argv) {
  return { send: argv.includes('--send') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const operatorKey = process.env.ENS_DEPLOYER_PRIVATE_KEY;
  if (!operatorKey) throw new Error('set ENS_DEPLOYER_PRIVATE_KEY');
  const rpcUrl = process.env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC;

  const registrar = SEPOLIA.subnameRegistrar;
  if (!registrar) {
    throw new Error(
      'deployments/sepolia.json has no subnameRegistrar address — run ' +
        'DeployRegistrar.s.sol first and record its address there.'
    );
  }

  const operator = privateKeyToAccount(operatorKey);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account: operator, chain: sepolia, transport: http(rpcUrl) });

  console.log(`  registrar         ${registrar}`);
  console.log(`  subnameRegistry   ${SEPOLIA.ens.subnameRegistry}`);
  console.log(`  resolver          ${SEPOLIA.ens.resolver}`);
  console.log(`  operator          ${operator.address}`);

  const hasRegistrarRole = await publicClient.readContract({
    address: SEPOLIA.ens.subnameRegistry,
    abi: registryAbi,
    functionName: 'hasRootRoles',
    args: [REGISTRY_ROLE_REGISTRAR, registrar]
  });
  const hasResolverRoles = await publicClient.readContract({
    address: SEPOLIA.ens.resolver,
    abi: resolverAbi,
    functionName: 'hasRootRoles',
    args: [RESOLVER_ROLES_VERDIKT_NEEDS, registrar]
  });

  console.log(`\n  ROLE_REGISTRAR granted?              ${hasRegistrarRole}`);
  console.log(`  RESOLVER_ROLES_VERDIKT_NEEDS granted? ${hasResolverRoles}`);

  if (!args.send) {
    console.log('\n  dry run — pass --send to broadcast whatever is still missing.');
    return;
  }

  const send = async (params) => {
    const { request } = await publicClient.simulateContract({ account: operator, ...params });
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`reverted: ${hash}`);
    return hash;
  };

  if (!hasRegistrarRole) {
    console.log('\n  granting ROLE_REGISTRAR on the subname registry…');
    await send({
      address: SEPOLIA.ens.subnameRegistry,
      abi: registryAbi,
      functionName: 'grantRootRoles',
      args: [REGISTRY_ROLE_REGISTRAR, registrar]
    });
  }
  if (!hasResolverRoles) {
    console.log('  granting RESOLVER_ROLES_VERDIKT_NEEDS on the resolver…');
    await send({
      address: SEPOLIA.ens.resolver,
      abi: resolverAbi,
      functionName: 'grantRootRoles',
      args: [RESOLVER_ROLES_VERDIKT_NEEDS, registrar]
    });
  }

  console.log('\nDone. The registrar can now run claim() for any slug.');
}

main().catch((error) => {
  console.error(`\ngrant failed: ${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
```

- [ ] **Step 6: Verify the script at least loads and dry-runs its argument parsing**

Run: `node -e "import('./scripts/grant-registrar-roles.mjs')"`
Expected: throws `deployments/sepolia.json has no subnameRegistrar address — run DeployRegistrar.s.sol first…` (because `subnameRegistrar` is still `null` from Step 1) — this is the *expected* failure mode right now and confirms the script's guard clause and imports both work.

- [ ] **Step 7: Commit**

```bash
git add contracts/script/DeployRegistrar.s.sol scripts/ens-sepolia.mjs scripts/grant-registrar-roles.mjs deployments/sepolia.json
git commit -m "Add the registrar deploy script and the operator role-grant script"
```

---

### Task 4: SDK — `ServiceRecord.owner`

**Files:**
- Modify: `packages/sdk/ens.js`
- Modify: `packages/sdk/ens.test.js`
- Modify: `packages/sdk/types.d.ts`
- Modify: `fixtures/index.js`

**Interfaces:**
- Consumes: `SEPOLIA.ens.subnameRegistry` (existing, `packages/sdk/deployments.js`).
- Produces: `ServiceRecord.owner: string | null`, `resolveServiceRecord`'s fixture backend also returns `owner: null` by default (from `SERVICE_RECORD`'s new field), `subnameRegistryAbi` exported from `packages/sdk/ens.js`.

- [ ] **Step 1: Write the failing test**

Open `packages/sdk/ens.test.js`. Extend the import list at the top to include `subnameRegistryAbi`:

```js
import {
  DEFAULT_PARENT_NAME,
  ENS_BACKEND,
  clearServiceRecordCache,
  dnsEncode,
  resolveServiceRecord,
  resolverRecordsAbi,
  serviceName,
  subnameRegistryAbi,
  writeServiceScores
} from './ens.js';
```

Replace the `mockRpc` function with a version that also answers a `getState` call against the subname registry, branching on the target address rather than assuming every call is `resolve`:

```js
import { SEPOLIA } from './deployments.js';

/**
 * Stands in for the Sepolia RPC. Two request shapes are answered: a
 * `resolve(name, data)` against the Universal Resolver (the existing four
 * records), and a `getState(anyId)` against the subname registry directly —
 * `owner` is not a resolver-routed record, it comes straight off the registry.
 *
 * @param {{ addr?: string, sla?: string, conformance?: string, availability?: string, owner?: string }} records
 *        Omit a key to make it unset; `revert` makes the whole name unresolvable.
 */
function mockRpc(records) {
  /** @param {`0x${string}`} data */
  const answerResolve = (data) => {
    const outer = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'resolve',
          stateMutability: 'view',
          inputs: [
            { name: 'name', type: 'bytes' },
            { name: 'data', type: 'bytes' }
          ],
          outputs: [
            { name: '', type: 'bytes' },
            { name: '', type: 'address' }
          ]
        }
      ],
      data
    });
    const inner = decodeFunctionData({ abi: resolverRecordsAbi, data: /** @type {`0x${string}`} */ (outer.args[1]) });

    /** @type {`0x${string}`} */
    let result = '0x';
    if (inner.functionName === 'addr' && records.addr !== undefined) {
      result = encodeFunctionResult({
        abi: resolverRecordsAbi,
        functionName: 'addr',
        result: /** @type {`0x${string}`} */ (records.addr)
      });
    }
    if (inner.functionName === 'text') {
      const key = /** @type {'sla'|'conformance'|'availability'} */ (inner.args?.[1]);
      if (records[key] !== undefined) {
        result = encodeFunctionResult({
          abi: resolverRecordsAbi,
          functionName: 'text',
          result: /** @type {string} */ (records[key])
        });
      }
    }
    return encodeAbiParameters(parseAbiParameters('bytes, address'), [result, RESOLVER]);
  };

  const answerGetState = () =>
    encodeFunctionResult({
      abi: subnameRegistryAbi,
      functionName: 'getState',
      result: {
        status: records.owner ? 2 : 0,
        expiry: 0n,
        latestOwner: records.owner ?? '0x0000000000000000000000000000000000000000',
        tokenId: 0n,
        resource: 0n
      }
    });

  return vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const one = (/** @type {{ id: number, params: [{ to: string, data: `0x${string}` }] }} */ request) => {
      const { to, data } = request.params[0];
      const result =
        to.toLowerCase() === SEPOLIA.ens.subnameRegistry.toLowerCase() ? answerGetState() : answerResolve(data);
      return { jsonrpc: '2.0', id: request.id, result };
    };
    const payload = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  });
}
```

Add a new test in the `describe('resolveServiceRecord', ...)` block, right after the existing `'returns all four records from one round trip'` test:

```js
  it('returns the subname owner alongside the four records, still in one round trip', async () => {
    const owner = '0x4444444444444444444444444444444444444444';
    const fetchMock = mockRpc({ addr: '0x1111111111111111111111111111111111111111', owner });
    vi.stubGlobal('fetch', fetchMock);

    const record = await resolveServiceRecord('weather', { rpcUrl: RPC });
    expect(record.owner).toBe(owner);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports an unclaimed subname as owner: null, not a zero address', async () => {
    vi.stubGlobal('fetch', mockRpc({}));
    const record = await resolveServiceRecord('weather', { rpcUrl: RPC });
    expect(record.owner).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/sdk/ens.test.js`
Expected: FAIL — `subnameRegistryAbi` is not exported from `./ens.js` yet, and `record.owner` is `undefined`.

- [ ] **Step 3: Implement `owner` in `packages/sdk/ens.js`**

Add a new ABI export near `resolverRecordsAbi` (after its definition, before `dnsEncode`):

```js
/**
 * The one `PermissionedRegistry` read the SDK needs directly — not through
 * the resolver, since `owner` is not a text or address record. Only what
 * `resolveServiceRecord` reads; the registrar/EAC-onboarding surface stays in
 * `scripts/ens-sepolia.mjs` per this file's own rule.
 */
export const subnameRegistryAbi = parseAbi([
  'function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))'
]);
```

In `resolveThroughUniversalResolver`, add an `owner` read alongside the existing four, in the same `Promise.all` (so it stays one HTTP round trip):

```js
  const readOwner = async () => {
    const state = await client.readContract({
      address: /** @type {`0x${string}`} */ (SEPOLIA.ens.subnameRegistry),
      abi: subnameRegistryAbi,
      functionName: 'getState',
      args: [BigInt(serviceId)]
    });
    return state.latestOwner === '0x0000000000000000000000000000000000000000' ? null : state.latestOwner;
  };

  const [address, url, sla, conformance, availability, owner] = await Promise.all([
    readAddr(),
    readText('url'),
    readText('sla'),
    readText('conformance'),
    readText('availability'),
    readOwner()
  ]);

  return {
    slug,
    name,
    serviceId,
    address,
    url,
    sla,
    conformance: conformance === null ? null : parseScore(conformance),
    availability: availability === null ? null : parseScore(availability),
    owner,
    backend: ENS_BACKEND.V2,
    resolvedAt: Date.now()
  };
```

`getState` never reverts for an unregistered `anyId` (Spike A: `getState` returns `AVAILABLE`/`RESERVED`/`REGISTERED` uniformly, never reverting on an unregistered label), so this needs no `isChainLevelRefusal` catch — an RPC that is genuinely unreachable still throws and propagates through `Promise.all`, same as every other read here.

`SEPOLIA` is already imported at the top of `ens.js` (`import { SEPOLIA } from './deployments.js';`), so no new import is needed for that name — only `subnameRegistryAbi` needs to be added to the existing `parseAbi` import block if not already covered (it is not — `parseAbi` is already imported).

- [ ] **Step 4: Add `owner` to `SERVICE_RECORD` in `fixtures/index.js`**

```js
export const SERVICE_RECORD = Object.freeze({
  slug: FIXTURE_SLUG,
  name: 'weather.verdikt.eth',
  serviceId: '0x0000000000000000000000000000000000000000000000000000000000000000',
  address: FIXTURE_PROVIDER_PAYOUT,
  url: 'https://provider.example/weather',
  sla: JSON.stringify(HONEST_SLA),
  conformance: 1000,
  availability: 1000,
  owner: null,
  backend: 'fixture',
  resolvedAt: 0
});
```

This makes the fixture backend (`resolveServiceRecord(slug, { backend: ENS_BACKEND.FIXTURE })`, which spreads `SERVICE_RECORD`) return `owner: null` automatically — no change needed to the fixture branch in `ens.js` itself.

- [ ] **Step 5: Add `owner` to `ServiceRecord` in `packages/sdk/types.d.ts`**

```ts
interface ServiceRecord {
  slug: string;
  name: string;
  serviceId: string;
  address: string | null;
  url: string | null;
  sla: string | null;
  conformance: number | null;
  availability: number | null;
  /**
   * The subname registry's `latestOwner` for this slug's ENS token — `null`
   * when nobody has claimed the subname yet. Compared against the Arc
   * `provider` by the proxy's `checkOwnership`: a permissionless registrar
   * means the ENS claim and the Arc registration are two independent
   * first-come claims, and a mismatch means the two disagree about who runs
   * this slug.
   */
  owner: string | null;
  backend: EnsBackend;
  resolvedAt: number;
}
```

(Insert the `owner` field and its doc comment right after `availability`, before `backend`, matching the field's position in the JS object above.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run packages/sdk/ens.test.js`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 7: Run the full test suite to confirm nothing else broke**

Run: `pnpm test`
Expected: PASS. (`web/src/marketplace.test.js`'s `record()` helper does not set `owner`, so it will be `undefined` there — that is fine for this task; Task 8 updates `marketplace.js`/`marketplace.test.js` to use it.)

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/ens.js packages/sdk/ens.test.js packages/sdk/types.d.ts fixtures/index.js
git commit -m "Resolve the ENS subname owner alongside a service's other records"
```

---

### Task 5: Proxy — refuse a slug whose ENS and Arc claims disagree

**Files:**
- Modify: `proxy/src/challenge.js`
- Modify: `proxy/src/router.js`
- Modify: `proxy/src/router.test.js`

**Interfaces:**
- Consumes: `record.owner` (Task 4), `state.provider` (existing, `registry.getService`).
- Produces: `checkOwnership(recordOwner, arcProvider)` exported from `challenge.js`; `BLOCK_REASON.OWNER_MISMATCH`.

- [ ] **Step 1: Write the failing tests**

In `proxy/src/router.test.js`, first extend the `harness()` helper so a test can set the registered provider (currently hardcoded to `'0x03'`). Change:

```js
function harness({ serviceRecord = {}, status = 'ACTIVE', upstream, ensError } = {}) {
```
to:
```js
function harness({ serviceRecord = {}, status = 'ACTIVE', provider = '0x03', upstream, ensError } = {}) {
```
and change the `registry.getService` mock line from:
```js
      getService: vi.fn(async () => ({ provider: '0x03', status, deposit: 10n ** 19n }))
```
to:
```js
      getService: vi.fn(async () => ({ provider, status, deposit: 10n ** 19n }))
```

Then add a new `describe` block, placed after `describe('refusals before any upstream call', ...)`:

```js
describe('ownership binding — a permissionless ENS claim vs. the Arc provider', () => {
  it('routes normally when the ENS owner matches the Arc provider', async () => {
    const { deps, upstreamFetch } = harness({
      provider: '0xAAAA000000000000000000000000000000AAAA',
      serviceRecord: { owner: '0xaaaa000000000000000000000000000000aaaa' }
    });
    const response = await getWeather(deps);
    expect(response.statusCode).toBe(200);
    expect(upstreamFetch).toHaveBeenCalled();
  });

  it('routes normally when nobody has claimed the subname yet', async () => {
    // owner: null means "unclaimed", not "contested" — the existing
    // no_address_record / no_endpoint checks are what should refuse this,
    // for their own reasons, not this one.
    const { deps, upstreamFetch } = harness({ serviceRecord: { owner: null } });
    const response = await getWeather(deps);
    expect(response.statusCode).toBe(200);
    expect(upstreamFetch).toHaveBeenCalled();
  });

  it('refuses to route when the ENS owner and the Arc provider disagree', async () => {
    const { deps, upstreamFetch } = harness({
      provider: '0xAAAA000000000000000000000000000000AAAA',
      serviceRecord: { owner: '0xBBBB000000000000000000000000000000BBBB' }
    });
    const response = await getWeather(deps);
    expect(response.statusCode).toBe(409);
    expect(response.headers['x-verdikt-block']).toBe('owner_mismatch');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('compares owner and provider without regard to checksum case', async () => {
    const { deps, upstreamFetch } = harness({
      provider: '0xAAAA000000000000000000000000000000AAAA',
      serviceRecord: { owner: '0xaaaa000000000000000000000000000000aaaa' }
    });
    await getWeather(deps);
    expect(upstreamFetch).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run proxy/src/router.test.js`
Expected: FAIL — `record()`'s spread of `SERVICE_RECORD` now includes `owner: null` (from Task 4), but nothing in `router.js` reads or checks it yet, so the mismatch case gets `200` instead of `409`.

- [ ] **Step 3: Add `checkOwnership` to `proxy/src/challenge.js`**

Add `OWNER_MISMATCH` to the existing `BLOCK_REASON` object:

```js
export const BLOCK_REASON = Object.freeze({
  NO_ADDRESS_RECORD: 'no_address_record',
  UNPARSEABLE_CHALLENGE: 'unparseable_challenge',
  NO_PAY_TO: 'challenge_has_no_pay_to',
  PAY_TO_MISMATCH: 'pay_to_mismatch',
  OWNER_MISMATCH: 'owner_mismatch'
});
```

Add a new function at the end of the file, after `checkChallenge`:

```js
/**
 * Refuses to relay when the ENS subname's owner and the Arc service's
 * registered provider disagree.
 *
 * A permissionless registrar (`VerdiktSubnameRegistrar`) means the ENS side
 * of a slug and the Arc side are two independent first-come claims with
 * nothing binding them once anyone but the operator can claim either. Without
 * this, a slug claimed on Arc by Alice but on ENS by Mallory would relay
 * through Mallory's `url` record and pay Mallory's `address` record —
 * silently, since both records individually look well-formed.
 *
 * `recordOwner === null` (nobody has claimed the subname through the
 * registrar yet) is not a mismatch: it falls through to the existing
 * `NO_ADDRESS_RECORD`/`NO_PAY_TO` checks, which already refuse an unclaimed
 * listing for a reason that stands on its own.
 *
 * @param {string|null} recordOwner the ENS subname's owner
 * @param {string} arcProvider the Arc-registered provider
 * @returns {{ ok: true } | { ok: false, reason: ChallengeBlockReason, detail: string }}
 */
export function checkOwnership(recordOwner, arcProvider) {
  if (!recordOwner) return { ok: true };
  if (recordOwner.toLowerCase() !== arcProvider.toLowerCase()) {
    return {
      ok: false,
      reason: BLOCK_REASON.OWNER_MISMATCH,
      detail: `the ENS subname is owned by ${recordOwner}, but Arc's registered provider is ${arcProvider} — this slug's two claims disagree and cannot be safely routed`
    };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Wire the check into `proxy/src/router.js`**

Add `checkOwnership` to the existing import from `./challenge.js`:

```js
import { BLOCK_REASON, checkChallenge, checkOwnership } from './challenge.js';
```

(`challenge.js` is currently imported only inside `passthrough` via the bare `checkChallenge` name — check the top-of-file import list and add `checkOwnership` there. If `BLOCK_REASON` is not currently imported at the top of `router.js`, add it too, since the new refusal response below references it.)

Immediately after the existing block that reads `state` (right after the `try { state = await registry.getService(...) } catch { ... }` block, and *before* the `if (state.status !== 'ACTIVE')` check), add:

```js
  const ownership = checkOwnership(record.owner, state.provider);
  if (!ownership.ok) {
    return json(
      { error: 'owner_mismatch', reason: ownership.reason, detail: ownership.detail, service: record.name },
      409,
      { 'x-verdikt-block': ownership.reason }
    );
  }
```

Placing it before the ACTIVE-status check means it runs on both the unpaid (`passthrough`) and paid (`verified`) legs uniformly, and before `joinUpstream` builds a URL out of `record.url` — a squatted `url` record is exactly what this exists to distrust.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run proxy/src/router.test.js`
Expected: PASS, all tests including the four new ones.

- [ ] **Step 6: Run the full test suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add proxy/src/challenge.js proxy/src/router.js proxy/src/router.test.js
git commit -m "Refuse to route a slug whose ENS owner and Arc provider disagree"
```

---

### Task 6: `web/src/marketplace.js` — surface and render `contested`

**Files:**
- Modify: `web/src/marketplace.js`
- Modify: `web/src/marketplace.test.js`
- Modify: `web/src/source.js` (demo `owner` fields)
- Modify: `web/types.d.ts`
- Modify: `web/src/render.js` (a visible badge — the flag is useless if nothing shows it)

**Interfaces:**
- Consumes: `record.owner` (Task 4).
- Produces: `Listing.contested: boolean`.

- [ ] **Step 1: Write the failing test**

In `web/src/marketplace.test.js`, add a test near the other `loadMarketplace` shaping tests:

```js
it('flags a listing as contested when the ENS owner and Arc provider disagree', async () => {
  const services = [
    {
      serviceId: HONEST,
      slug: 'weather',
      provider: '0xaaaa000000000000000000000000000000aaaa',
      status: 'ACTIVE',
      deposit: 10n ** 19n,
      registeredAtBlock: 1n
    }
  ];
  const records = { weather: record({ owner: '0xbbbb000000000000000000000000000000bbbb' }) };
  const { services: listings } = await loadMarketplace(deps({ services, records }));
  expect(listings[0].contested).toBe(true);
});

it('does not flag a listing whose subname is simply unclaimed', async () => {
  const services = [
    {
      serviceId: HONEST,
      slug: 'weather',
      provider: '0xaaaa000000000000000000000000000000aaaa',
      status: 'ACTIVE',
      deposit: 10n ** 19n,
      registeredAtBlock: 1n
    }
  ];
  const records = { weather: record({ owner: null }) };
  const { services: listings } = await loadMarketplace(deps({ services, records }));
  expect(listings[0].contested).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run web/src/marketplace.test.js`
Expected: FAIL — `listings[0].contested` is `undefined`.

- [ ] **Step 3: Implement `contested` in `web/src/marketplace.js`**

In the `listings = services.map((service, index) => { ... })` block, add a `contested` computation and field:

```js
    const contested = record !== null && record.owner !== null && record.owner.toLowerCase() !== service.provider.toLowerCase();

    return {
      serviceId: service.serviceId,
      slug: service.slug,
      name: record?.name ?? `${service.slug}.verdikt.eth`,
      provider: service.provider,
      status: service.status,
      deposit: service.deposit,
      endpoint: record?.url ?? null,
      payTo: record?.address ?? null,
      namingLayer: /** @type {'ok'|'unreachable'} */ (record === null ? 'unreachable' : 'ok'),
      contested,
      sla,
      slaRaw: record?.sla ?? null,
      published: { conformance: record?.conformance ?? null, availability: record?.availability ?? null },
      unpublished: aggregateWindow(own),
      history
    };
```

- [ ] **Step 4: Add `contested` to `Listing` in `web/types.d.ts`**

```ts
interface Listing {
  serviceId: string;
  slug: string;
  name: string;
  provider: string;
  status: ServiceStatus;
  deposit: bigint;
  endpoint: string | null;
  payTo: string | null;
  namingLayer: 'ok' | 'unreachable';
  /**
   * The ENS subname's owner and the Arc registration's provider disagree. The
   * proxy already refuses to route such a listing (`checkOwnership`) — this
   * is the same fact, surfaced for the marketplace to render rather than
   * silently list a service nobody can actually call.
   */
  contested: boolean;
  sla: SlaDocument | null;
  slaRaw: string | null;
  published: { conformance: number | null; availability: number | null };
  unpublished: ReputationScores;
  history: ListingVerdict[];
}
```

- [ ] **Step 4a: Render the contested badge in `web/src/render.js`**

Two spots, mirroring the existing `unranked`/`namingLayer` aside patterns already in this file. First, in `listingRow` (the row builder near the top of `render.js`), add a badge next to the existing `unranked` marker:

```js
function listingRow(listing, selected) {
  const published = listing.published;
  const unranked = published.conformance === null && published.availability === null;
  return `
    <button class="row${selected ? ' selected' : ''}" data-slug="${escape(listing.slug)}" type="button">
      <span class="cell name">
        <strong>${escape(listing.slug)}</strong>
        <small>${escape(listing.name)}</small>
        ${listing.contested ? '<span class="contested">contested</span>' : ''}
        ${unranked ? '<span class="unranked">not yet ranked</span>' : ''}
      </span>
      <span class="cell num">${scoreCell(published.conformance)}</span>
      <span class="cell num">${scoreCell(published.availability)}</span>
      <span class="cell num">${amount(formatNativeUsdc(listing.deposit, 2))}</span>
      <span class="cell status">${statusMark(listing.status)}</span>
    </button>`;
}
```

Second, in `renderDetail`, add an aside right after the existing `namingLayer === 'unreachable'` aside (same `${ ... ? ... : '' }` ternary-block style already used there):

```js
    ${
      listing.contested
        ? `<p class="aside warn">
             This slug's ENS subname and its Arc registration are owned by different
             addresses. The proxy refuses to route it until they agree — see
             <a href="?view=how">how it works</a>.
           </p>`
        : ''
    }
```

Insert this block immediately after the existing `namingLayer === 'unreachable'` ternary block and before the `<section class="block"><h3>Endpoint</h3>` section, so it reads in the same place a naming-layer problem would.

Add the badge's styling in `web/src/styles.css`, next to the existing `.cell.name .unranked` rule:
```css
.cell.name .contested { color: var(--poor); font-size: 12px; font-weight: 500; }
```

- [ ] **Step 5: Set `owner` on the demo records in `web/src/source.js`**

In `demoSource()`'s `records` object, add `owner` matching each service's own `provider`, so demo mode never shows a false contested flag:

```js
  const records = {
    weather: {
      slug: 'weather',
      name: 'weather.verdikt.eth',
      serviceId: honest,
      address: '0x2222222222222222222222222222222222222222',
      url: 'https://weather.demo.verdikt.bond/v1/current',
      sla: SLA_TEXT.honest,
      conformance: 1000,
      availability: 958,
      owner: '0xA11ce00000000000000000000000000000000001',
      backend: ENS_BACKEND.FIXTURE,
      resolvedAt: 0
    },
    'weather-lite': {
      slug: 'weather-lite',
      name: 'weather-lite.verdikt.eth',
      serviceId: flaky,
      address: '0x3333333333333333333333333333333333333333',
      url: 'https://weather-lite.demo.verdikt.bond/v1/current',
      sla: SLA_TEXT.violating,
      conformance: 0,
      availability: 1000,
      owner: '0xB0b0000000000000000000000000000000000002',
      backend: ENS_BACKEND.FIXTURE,
      resolvedAt: 0
    }
  };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run web/src/marketplace.test.js`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 7: Run the full test suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/marketplace.js web/src/marketplace.test.js web/src/source.js web/types.d.ts web/src/render.js web/src/styles.css
git commit -m "Surface a contested-ownership flag on marketplace listings"
```

---

### Task 7: `web/src/wallet.js` — EIP-6963 wallet connection

**Files:**
- Create: `web/src/wallet.js`
- Test: `web/src/wallet.test.js`
- Modify: `web/package.json` (add `viem` as a direct dependency)

**Interfaces:**
- Produces: `connectWallet(): Promise<{ address: string, chainId: number }>`, `getConnectedAccount(): { address: string, chainId: number } | null`, `ensureChain(chainId: number, chainConfig: object): Promise<void>`, `onAccountChange(fn: (address: string|null) => void): () => void`, `walletClientFor(chainConfig: object): WalletClient`.

- [ ] **Step 1: Add `viem` as a direct dependency**

Edit `web/package.json`'s `dependencies` block:

```json
  "dependencies": {
    "@verdikt/cre": "workspace:*",
    "@verdikt/sdk": "workspace:*",
    "@verdikt/sla": "workspace:*",
    "viem": "^2.56.3"
  },
```

Run: `pnpm install`
Expected: lockfile updates, no errors (already resolved elsewhere in the workspace at the same version).

- [ ] **Step 2: Write the failing test**

Create `web/src/wallet.test.js`. This tests `wallet.js` against a fake EIP-1193 provider (`window.ethereum`-shaped), not a real browser wallet:

```js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectWallet,
  ensureChain,
  getConnectedAccount,
  onAccountChange,
  resetWalletStateForTests
} from './wallet.js';

/** @param {{ requestResult?: Record<string, unknown>, throwOn?: string, switchError?: { code: number } }} [options] */
function fakeProvider({ requestResult = {}, throwOn, switchError } = {}) {
  const listeners = new Map();
  const provider = {
    request: vi.fn(async ({ method, params }) => {
      if (method === throwOn) throw new Error(`${method} failed`);
      if (method === 'eth_requestAccounts') return requestResult.accounts ?? ['0xAaAa000000000000000000000000000000AaAa'];
      if (method === 'eth_chainId') return requestResult.chainId ?? '0x1';
      if (method === 'wallet_switchEthereumChain') {
        if (switchError) {
          const error = new Error('unrecognized chain');
          error.code = switchError.code;
          throw error;
        }
        return null;
      }
      if (method === 'wallet_addEthereumChain') return null;
      throw new Error(`unexpected method ${method}`);
    }),
    on: vi.fn((event, fn) => listeners.set(event, fn)),
    removeListener: vi.fn((event) => listeners.delete(event)),
    _emit: (event, ...args) => listeners.get(event)?.(...args)
  };
  return provider;
}

/**
 * `wallet.js`'s `discoverProvider` does a synchronous EIP-6963
 * announce/request/remove dance on `window` itself — `addEventListener`,
 * `dispatchEvent`, AND `removeEventListener`, in that order. A stub missing
 * any one of the three throws mid-connect, so all three are provided here
 * once rather than separately at every call site.
 * @param {{ ethereum?: unknown }} [options]
 */
function fakeWindow({ ethereum } = {}) {
  return { ethereum, addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() };
}

beforeEach(() => {
  resetWalletStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connectWallet', () => {
  it('requests accounts and returns the first one with the current chain', async () => {
    const provider = fakeProvider({ requestResult: { accounts: ['0xAaAa000000000000000000000000000000AaAa'], chainId: '0x2711' } });
    vi.stubGlobal('window', fakeWindow({ ethereum: provider }));

    const account = await connectWallet();
    expect(account.address).toBe('0xAaAa000000000000000000000000000000AaAa');
    expect(account.chainId).toBe(10001);
  });

  it('throws plainly when no provider is available', async () => {
    vi.stubGlobal('window', fakeWindow());
    await expect(connectWallet()).rejects.toThrow(/no wallet/i);
  });

  it('remembers the connected account for getConnectedAccount', async () => {
    const provider = fakeProvider();
    vi.stubGlobal('window', fakeWindow({ ethereum: provider }));
    expect(getConnectedAccount()).toBeNull();
    await connectWallet();
    expect(getConnectedAccount()?.address).toBe('0xAaAa000000000000000000000000000000AaAa');
  });
});

describe('ensureChain', () => {
  it('switches chains when the wallet already knows the chain', async () => {
    const provider = fakeProvider();
    vi.stubGlobal('window', fakeWindow({ ethereum: provider }));
    await connectWallet();
    await ensureChain(10001, { chainId: 10001, name: 'Arc Testnet', rpcUrl: 'https://rpc.testnet.arc.network' });
    expect(provider.request).toHaveBeenCalledWith({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x2711' }]
    });
  });

  it('adds the chain when the wallet does not recognise it (error code 4902)', async () => {
    const provider = fakeProvider({ switchError: { code: 4902 } });
    vi.stubGlobal('window', fakeWindow({ ethereum: provider }));
    await connectWallet();
    await ensureChain(10001, {
      chainId: 10001,
      name: 'Arc Testnet',
      rpcUrl: 'https://rpc.testnet.arc.network',
      nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 }
    });
    expect(provider.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'wallet_addEthereumChain' })
    );
  });
});

describe('onAccountChange', () => {
  it('notifies listeners when the wallet reports accountsChanged, and null on disconnect', async () => {
    const provider = fakeProvider();
    vi.stubGlobal('window', fakeWindow({ ethereum: provider }));
    await connectWallet();

    const seen = [];
    const unsubscribe = onAccountChange((address) => seen.push(address));
    provider._emit('accountsChanged', ['0xBbBb000000000000000000000000000000BbBb']);
    provider._emit('accountsChanged', []);

    expect(seen).toEqual(['0xBbBb000000000000000000000000000000BbBb', null]);
    unsubscribe();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run web/src/wallet.test.js`
Expected: FAIL — `wallet.js` does not exist.

- [ ] **Step 4: Write the implementation**

Create `web/src/wallet.js`:

```js
// The only file that knows a browser wallet exists — same choke-point idiom
// as @verdikt/sdk/ens.js. Two chains (Sepolia for ENS writes, Arc for the
// registry) means every caller needs the same connect/switch-chain dance, and
// this is the one place it is written.
//
// EIP-6963 (`eip6963:announceProvider`) is preferred where a page supports
// multiple installed wallets; `window.ethereum` is the fallback every wallet
// still injects. No wallet-connection library: the whole surface here is
// "get an account, switch a chain, hear about changes" — three things viem's
// own `custom` transport and a dozen lines already cover.

import { createWalletClient, custom } from 'viem';

/** @type {{ address: string, chainId: number } | null} */
let connected = null;
/** @type {unknown} */
let activeProvider = null;
/** @type {Set<(address: string|null) => void>} */
const listeners = new Set();

/** Test-only: clears module state between tests. */
export function resetWalletStateForTests() {
  connected = null;
  activeProvider = null;
  listeners.clear();
}

/** @returns {unknown} */
function discoverProvider() {
  // EIP-6963 first: a page with multiple wallets gets whichever announced
  // itself most recently, which is closer to "the one the user just clicked"
  // than window.ethereum's single, overwritten-on-conflict slot.
  /** @type {unknown} */
  let found = /** @type {{ ethereum?: unknown }} */ (window).ethereum ?? null;
  const onAnnounce = (/** @type {CustomEvent} */ event) => {
    found = /** @type {{ provider: unknown }} */ (event.detail).provider;
  };
  window.addEventListener('eip6963:announceProvider', /** @type {EventListener} */ (onAnnounce));
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  window.removeEventListener('eip6963:announceProvider', /** @type {EventListener} */ (onAnnounce));
  return found;
}

/**
 * @param {unknown} provider
 * @param {{ method: string, params?: unknown[] }} args
 */
const request = (provider, args) => /** @type {{ request: Function }} */ (provider).request(args);

/** @returns {Promise<{ address: string, chainId: number }>} */
export async function connectWallet() {
  const provider = discoverProvider();
  if (!provider) throw new Error('no wallet found — install one or connect through a browser extension');

  const accounts = /** @type {string[]} */ (await request(provider, { method: 'eth_requestAccounts' }));
  const chainIdHex = /** @type {string} */ (await request(provider, { method: 'eth_chainId' }));

  activeProvider = provider;
  connected = { address: accounts[0], chainId: Number.parseInt(chainIdHex, 16) };

  /** @type {{ on?: Function }} */ (provider).on?.('accountsChanged', (/** @type {string[]} */ next) => {
    connected = next.length > 0 ? { ...connected, address: next[0] } : null;
    for (const listener of listeners) listener(next.length > 0 ? next[0] : null);
  });
  /** @type {{ on?: Function }} */ (provider).on?.('chainChanged', (/** @type {string} */ hex) => {
    if (connected) connected = { ...connected, chainId: Number.parseInt(hex, 16) };
  });

  return connected;
}

/** @returns {{ address: string, chainId: number } | null} */
export function getConnectedAccount() {
  return connected;
}

/**
 * @param {(address: string|null) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onAccountChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Switches the connected wallet to `chainId`, adding it first if the wallet
 * has never seen it — neither Arc Testnet nor Sepolia's public RPC is a
 * default in most wallets.
 *
 * @param {number} chainId
 * @param {{ chainId: number, name: string, rpcUrl: string, nativeCurrency?: { name: string, symbol: string, decimals: number }, blockExplorerUrl?: string }} chainConfig
 */
export async function ensureChain(chainId, chainConfig) {
  if (!activeProvider) throw new Error('connect a wallet before switching chains');
  const hex = `0x${chainId.toString(16)}`;
  try {
    await request(activeProvider, { method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (error) {
    // 4902: the wallet has never heard of this chain — add it, then it can switch.
    if (/** @type {{ code?: number }} */ (error).code !== 4902) throw error;
    await request(activeProvider, {
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hex,
          chainName: chainConfig.name,
          rpcUrls: [chainConfig.rpcUrl],
          nativeCurrency: chainConfig.nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
          blockExplorerUrls: chainConfig.blockExplorerUrl ? [chainConfig.blockExplorerUrl] : undefined
        }
      ]
    });
  }
}

/**
 * A viem wallet client over the connected EIP-1193 provider, for `actions.js`
 * to send transactions through.
 *
 * @param {{ chainId: number, name: string, rpcUrl: string, nativeCurrency?: object }} chainConfig
 */
export function walletClientFor(chainConfig) {
  if (!activeProvider || !connected) throw new Error('connect a wallet first');
  return createWalletClient({
    account: /** @type {`0x${string}`} */ (connected.address),
    chain: {
      id: chainConfig.chainId,
      name: chainConfig.name,
      nativeCurrency: chainConfig.nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [chainConfig.rpcUrl] } }
    },
    transport: custom(/** @type {any} */ (activeProvider))
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run web/src/wallet.test.js`
Expected: PASS, all tests.

- [ ] **Step 6: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add web/package.json web/src/wallet.js web/src/wallet.test.js pnpm-lock.yaml
git commit -m "Add EIP-6963 wallet connection to the dashboard"
```

---

### Task 8: `web/src/session.js` — SIWE identity gate

**Files:**
- Create: `web/src/session.js`
- Test: `web/src/session.test.js`

**Interfaces:**
- Consumes: `walletClientFor`, `getConnectedAccount`, `onAccountChange` (Task 7).
- Produces: `signIn(chainId: number): Promise<{ address: string, expiresAt: number }>`, `getSession(): { address: string, expiresAt: number } | null`, `clearSession(): void`.

- [ ] **Step 1: Write the failing test**

Create `web/src/session.test.js`:

```js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { clearSession, getSession, signIn } from './session.js';

const ACCOUNT = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690');

/** A localStorage-shaped in-memory stub — jsdom is not part of this project's test setup. */
function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSession();
});

describe('signIn', () => {
  it('signs a SIWE message with the connected wallet and persists a session', async () => {
    const walletClient = { signMessage: vi.fn(async ({ message }) => ACCOUNT.signMessage({ message })) };

    const session = await signIn(11155111, { address: ACCOUNT.address, walletClient, domain: 'verdikt.example', origin: 'https://verdikt.example' });

    expect(session.address.toLowerCase()).toBe(ACCOUNT.address.toLowerCase());
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(getSession()?.address.toLowerCase()).toBe(ACCOUNT.address.toLowerCase());
  });

  it('rejects a signature from a different address than the one requested', async () => {
    const other = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001');
    const walletClient = { signMessage: vi.fn(async ({ message }) => other.signMessage({ message })) };

    await expect(
      signIn(11155111, { address: ACCOUNT.address, walletClient, domain: 'verdikt.example', origin: 'https://verdikt.example' })
    ).rejects.toThrow();
  });
});

describe('getSession', () => {
  it('returns null when nothing has signed in', () => {
    expect(getSession()).toBeNull();
  });

  it('returns null once the session has expired', async () => {
    vi.useFakeTimers();
    const walletClient = { signMessage: vi.fn(async ({ message }) => ACCOUNT.signMessage({ message })) };
    await signIn(11155111, { address: ACCOUNT.address, walletClient, domain: 'verdikt.example', origin: 'https://verdikt.example', ttlMs: 1000 });
    vi.advanceTimersByTime(2000);
    expect(getSession()).toBeNull();
    vi.useRealTimers();
  });
});

describe('clearSession', () => {
  it('drops a signed-in session', async () => {
    const walletClient = { signMessage: vi.fn(async ({ message }) => ACCOUNT.signMessage({ message })) };
    await signIn(11155111, { address: ACCOUNT.address, walletClient, domain: 'verdikt.example', origin: 'https://verdikt.example' });
    clearSession();
    expect(getSession()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run web/src/session.test.js`
Expected: FAIL — `session.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `web/src/session.js`:

```js
// A client-side proof of address control — not an authorization boundary.
// Every provider write is its own wallet-signed transaction regardless of
// this session's state (web/src/actions.js); signing in only unlocks the
// write affordances in the UI and gives the page a "signed in as 0x…"
// identity to show. There is no backend here to protect: nothing server-side
// exists yet that this session would be presented to.

import { recoverMessageAddress } from 'viem';
import { createSiweMessage, generateSiweNonce, parseSiweMessage, validateSiweMessage } from 'viem/siwe';

const STORAGE_KEY = 'verdikt.session';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @param {number} chainId
 * @param {{
 *   address: string,
 *   walletClient: { signMessage: (args: { account?: unknown, message: string }) => Promise<string> },
 *   domain: string,
 *   origin: string,
 *   ttlMs?: number
 * }} options
 * @returns {Promise<{ address: string, expiresAt: number }>}
 */
export async function signIn(chainId, { address, walletClient, domain, origin, ttlMs = DEFAULT_TTL_MS }) {
  const nonce = generateSiweNonce();
  const issuedAt = new Date();
  const message = createSiweMessage({
    address: /** @type {`0x${string}`} */ (address),
    chainId,
    domain,
    nonce,
    issuedAt,
    statement: 'Sign in to Verdikt. This proves you control this address — it authorizes nothing by itself.',
    uri: origin,
    version: '1'
  });

  const signature = /** @type {`0x${string}`} */ (await walletClient.signMessage({ message }));

  const recovered = await recoverMessageAddress({ message, signature });
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new Error('the signature does not match the requested address');
  }

  const parsed = parseSiweMessage(message);
  const valid = validateSiweMessage({ address: /** @type {`0x${string}`} */ (address), domain, message: parsed, nonce, time: issuedAt });
  if (!valid) throw new Error('the signed SIWE message failed validation');

  const session = { address, expiresAt: issuedAt.getTime() + ttlMs };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

/** @returns {{ address: string, expiresAt: number } | null} */
export function getSession() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  /** @type {{ address: string, expiresAt: number }} */
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!session.expiresAt || session.expiresAt <= Date.now()) {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return session;
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run web/src/session.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/session.js web/src/session.test.js
git commit -m "Add a client-side SIWE identity gate to the dashboard"
```

---

### Task 9: `web/src/router.js` — URL-driven view state

**Files:**
- Create: `web/src/router.js`
- Test: `web/src/router.test.js`

**Interfaces:**
- Produces: `readRoute(url: URL): { view: 'marketplace'|'provider'|'how', service: string|null, provider: string|null }`, `withService(url: URL, slug: string): URL`, `withProvider(url: URL, address: string): URL`, `withView(url: URL, view: string): URL`.

Every function here is pure — takes a `URL`, returns a value or a new `URL`, never reads or writes `location`/`history` itself. `vitest.config.js` runs the whole workspace under `environment: 'node'`, which has no `location`/`history` globals; rather than adding a DOM emulation dependency for one file, the one caller that actually has a real `location`/`history` — `main.js` (Task 14) — owns calling `history.replaceState` with what these functions compute. This also matches `marketplace.js`'s own stated approach: "pure data shaping over injected readers... is what makes it testable without either chain."

- [ ] **Step 1: Write the failing test**

Create `web/src/router.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { readRoute, withProvider, withService, withView } from './router.js';

describe('readRoute', () => {
  it('defaults to the marketplace view with nothing selected', () => {
    expect(readRoute(new URL('https://verdikt.example/'))).toEqual({ view: 'marketplace', service: null, provider: null });
  });

  it('reads an explicit view, service and provider', () => {
    const route = readRoute(new URL('https://verdikt.example/?view=provider&service=weather&provider=0xAaAa'));
    expect(route).toEqual({ view: 'provider', service: 'weather', provider: '0xAaAa' });
  });

  it('treats a bare ?provider= link as the provider view, unchanged from today', () => {
    // The existing public deep link — must keep working with no ?view= at all.
    const route = readRoute(new URL('https://verdikt.example/?provider=0xAaAa'));
    expect(route).toEqual({ view: 'provider', service: null, provider: '0xAaAa' });
  });

  it('falls back to the marketplace view for an unrecognised ?view=', () => {
    const route = readRoute(new URL('https://verdikt.example/?view=nonsense'));
    expect(route.view).toBe('marketplace');
  });
});

describe('withService / withProvider / withView', () => {
  it('withService sets ?service= and preserves the current view, without mutating the input', () => {
    const input = new URL('https://verdikt.example/?view=marketplace');
    const next = withService(input, 'weather');
    expect(next.searchParams.get('service')).toBe('weather');
    expect(next.searchParams.get('view')).toBe('marketplace');
    expect(input.searchParams.get('service')).toBeNull();
  });

  it('withProvider sets ?provider= and ?view=provider', () => {
    const next = withProvider(new URL('https://verdikt.example/'), '0xAaAa');
    expect(next.searchParams.get('provider')).toBe('0xAaAa');
    expect(next.searchParams.get('view')).toBe('provider');
  });

  it('withView replaces the view without disturbing service/provider', () => {
    const next = withView(new URL('https://verdikt.example/?service=weather'), 'how');
    expect(next.searchParams.get('view')).toBe('how');
    expect(next.searchParams.get('service')).toBe('weather');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run web/src/router.test.js`
Expected: FAIL — `router.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `web/src/router.js`:

```js
// The one place the dashboard shapes its own URL. Query params, not paths:
// `web` is a static single page (CLAUDE.md), so there is no server to
// configure an SPA fallback on, and query params need none either.
//
// Every function here is pure: takes a URL, returns a value or a new URL, and
// never touches `location`/`history` itself — the one caller that has a real
// `location`/`history` (main.js) is the one that calls `history.replaceState`
// with what these compute. That is what keeps this file testable in plain
// Node, with no DOM emulation dependency for one file to need.
//
// `?provider=0x…` predates this file and is a public, shareable deep link to
// any provider's page — it must keep working with no `?view=` at all, which
// is why readRoute treats a bare `provider` param as `view: 'provider'`.

const VIEWS = /** @type {const} */ (['marketplace', 'provider', 'how']);

/**
 * @param {URL} url
 * @returns {{ view: 'marketplace'|'provider'|'how', service: string|null, provider: string|null }}
 */
export function readRoute(url) {
  const params = url.searchParams;
  const provider = params.get('provider');
  const requestedView = params.get('view');
  /** @type {'marketplace'|'provider'|'how'} */
  const view = requestedView && /** @type {readonly string[]} */ (VIEWS).includes(requestedView)
    ? /** @type {'marketplace'|'provider'|'how'} */ (requestedView)
    : provider
      ? 'provider'
      : 'marketplace';
  return { view, service: params.get('service'), provider };
}

/**
 * @param {URL} url
 * @param {string} slug
 * @returns {URL}
 */
export function withService(url, slug) {
  const next = new URL(url);
  next.searchParams.set('service', slug);
  return next;
}

/**
 * @param {URL} url
 * @param {string} address
 * @returns {URL}
 */
export function withProvider(url, address) {
  const next = new URL(url);
  next.searchParams.set('provider', address);
  next.searchParams.set('view', 'provider');
  return next;
}

/**
 * @param {URL} url
 * @param {string} view
 * @returns {URL}
 */
export function withView(url, view) {
  const next = new URL(url);
  next.searchParams.set('view', view);
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run web/src/router.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/router.js web/src/router.test.js
git commit -m "Add URL-driven view routing to the dashboard"
```

---

### Task 10: `web/src/actions.js` — provider write calls

**Files:**
- Create: `web/src/actions.js`
- Test: `web/src/actions.test.js`

**Interfaces:**
- Consumes: `walletClientFor` (Task 7), `setTextCalldata`, `SEPOLIA`, `ARC` (existing, `@verdikt/sdk`).
- Produces: `claimSubname`, `registerService`, `topUpBond`, `retireService`, `publishSla`, `publishUrl` — each `async (params) => Promise<{ hash: string }>`.

- [ ] **Step 1: Write the failing test**

Create `web/src/actions.test.js`. Since `actions.js` only orchestrates calls through an injected wallet client (never constructs one itself in these code paths — that's `wallet.js`'s job), tests pass a fake wallet client directly:

```js
import { describe, expect, it, vi } from 'vitest';
import { claimSubname, publishSla, publishUrl, registerService, retireService, topUpBond } from './actions.js';

/** @param {Record<string, unknown>} [overrides] */
function fakeWalletClient(overrides = {}) {
  return {
    writeContract: vi.fn(async () => '0xhash'),
    sendTransaction: vi.fn(async () => '0xhash'),
    ...overrides
  };
}

describe('claimSubname', () => {
  it('calls the registrar with the slug and payTo', async () => {
    const walletClient = fakeWalletClient();
    const registrarAddress = '0xREG0000000000000000000000000000000000';
    const result = await claimSubname({ walletClient, registrarAddress, slug: 'weather', payTo: '0xPay000000000000000000000000000000000000' });
    expect(result.hash).toBe('0xhash');
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: registrarAddress,
        functionName: 'claim',
        args: ['weather', '0xPay000000000000000000000000000000000000']
      })
    );
  });
});

describe('registerService', () => {
  it('calls register with the slug and the exact deposit amount as value', async () => {
    const walletClient = fakeWalletClient();
    const registryAddress = '0xREGISTRY000000000000000000000000000000';
    const result = await registerService({ walletClient, registryAddress, slug: 'weather', depositAmount: 10n * 10n ** 18n });
    expect(result.hash).toBe('0xhash');
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: registryAddress, functionName: 'register', args: ['weather'], value: 10n * 10n ** 18n })
    );
  });
});

describe('topUpBond', () => {
  it('calls topUp with the serviceId and the top-up amount as value', async () => {
    const walletClient = fakeWalletClient();
    const registryAddress = '0xREGISTRY000000000000000000000000000000';
    const serviceId = `0x${'1'.repeat(64)}`;
    const result = await topUpBond({ walletClient, registryAddress, serviceId, amount: 5n * 10n ** 18n });
    expect(result.hash).toBe('0xhash');
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: registryAddress, functionName: 'topUp', args: [serviceId], value: 5n * 10n ** 18n })
    );
  });
});

describe('retireService', () => {
  it('calls deregister with the serviceId', async () => {
    const walletClient = fakeWalletClient();
    const registryAddress = '0xREGISTRY000000000000000000000000000000';
    const serviceId = `0x${'2'.repeat(64)}`;
    const result = await retireService({ walletClient, registryAddress, serviceId });
    expect(result.hash).toBe('0xhash');
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: registryAddress, functionName: 'deregister', args: [serviceId] })
    );
  });
});

describe('publishSla / publishUrl', () => {
  it('sends the setText calldata @verdikt/sdk already builds, for sla', async () => {
    const walletClient = fakeWalletClient();
    const result = await publishSla({ walletClient, slug: 'weather', value: '{"version":1,"clauses":[]}' });
    expect(result.hash).toBe('0xhash');
    expect(walletClient.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: expect.stringMatching(/^0x/), data: expect.stringMatching(/^0x/) })
    );
  });

  it('sends the setText calldata for url', async () => {
    const walletClient = fakeWalletClient();
    const result = await publishUrl({ walletClient, slug: 'weather', value: 'https://provider.example/weather' });
    expect(result.hash).toBe('0xhash');
    expect(walletClient.sendTransaction).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run web/src/actions.test.js`
Expected: FAIL — `actions.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `web/src/actions.js`:

```js
// The six transactions a signed-in provider can send, each a thin wrapper
// around a wallet client's own writeContract/sendTransaction — never a
// Verdikt-held key. `@verdikt/sla` is a dependency here on purpose: unlike the
// proxy, the dashboard's provider console is squarely on the human side of
// the enclave boundary (CLAUDE.md), and the caller — not this file — decides
// when to validate a draft with parseSla before calling publishSla.

import { parseAbi } from 'viem';
import { setTextCalldata } from '@verdikt/sdk';

/**
 * Provider-facing write surface of VerdiktRegistry. Deliberately not
 * @verdikt/sdk/arc's registryAbi — that file's ABI is the read surface the
 * proxy also uses, and register/topUp/deregister are provider actions with no
 * business in a reader shared with the proxy (packages/sdk/arc.js's own
 * comment on this).
 */
export const registryWriteAbi = parseAbi([
  'function register(string calldata slug) external payable returns (bytes32 serviceId)',
  'function topUp(bytes32 serviceId) external payable',
  'function deregister(bytes32 serviceId) external'
]);

/** VerdiktSubnameRegistrar's one entrypoint. */
export const registrarAbi = parseAbi(['function claim(string calldata slug, address payTo) external returns (bytes32 node)']);

/**
 * @param {{ walletClient: { writeContract: Function }, registrarAddress: string, slug: string, payTo: string }} params
 */
export async function claimSubname({ walletClient, registrarAddress, slug, payTo }) {
  const hash = await walletClient.writeContract({
    address: registrarAddress,
    abi: registrarAbi,
    functionName: 'claim',
    args: [slug, payTo]
  });
  return { hash };
}

/**
 * @param {{ walletClient: { writeContract: Function }, registryAddress: string, slug: string, depositAmount: bigint }} params
 */
export async function registerService({ walletClient, registryAddress, slug, depositAmount }) {
  const hash = await walletClient.writeContract({
    address: registryAddress,
    abi: registryWriteAbi,
    functionName: 'register',
    args: [slug],
    value: depositAmount
  });
  return { hash };
}

/**
 * @param {{ walletClient: { writeContract: Function }, registryAddress: string, serviceId: string, amount: bigint }} params
 */
export async function topUpBond({ walletClient, registryAddress, serviceId, amount }) {
  const hash = await walletClient.writeContract({
    address: registryAddress,
    abi: registryWriteAbi,
    functionName: 'topUp',
    args: [serviceId],
    value: amount
  });
  return { hash };
}

/**
 * @param {{ walletClient: { writeContract: Function }, registryAddress: string, serviceId: string }} params
 */
export async function retireService({ walletClient, registryAddress, serviceId }) {
  const hash = await walletClient.writeContract({
    address: registryAddress,
    abi: registryWriteAbi,
    functionName: 'deregister',
    args: [serviceId]
  });
  return { hash };
}

/**
 * @param {{ walletClient: { sendTransaction: Function }, slug: string, value: string }} params
 */
export async function publishSla({ walletClient, slug, value }) {
  const call = setTextCalldata(slug, 'sla', value);
  const hash = await walletClient.sendTransaction({ to: call.to, data: call.data });
  return { hash };
}

/**
 * @param {{ walletClient: { sendTransaction: Function }, slug: string, value: string }} params
 */
export async function publishUrl({ walletClient, slug, value }) {
  const call = setTextCalldata(slug, 'url', value);
  const hash = await walletClient.sendTransaction({ to: call.to, data: call.data });
  return { hash };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run web/src/actions.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/actions.js web/src/actions.test.js
git commit -m "Add the provider write actions the console sends through a wallet"
```

---

### Task 11: Navigation shell — masthead nav, GitHub/X links, how-it-works view

**Files:**
- Create: `web/src/nav.js`
- Create: `web/src/views/how-it-works.js`
- Modify: `web/src/render.js`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `readRoute` (Task 9), `mode` (existing, from `createSource`).
- Produces: `renderNav({ view, mode }): string`, `renderHowItWorks(): string`, `renderApp` gains a `view` parameter and dispatches to the how-it-works view.

No automated test for this task: it is markup generation with no branching logic beyond what `renderApp` already has coverage for via `marketplace.test.js`'s existing `renderApp`/`renderDetail` assertions. Verified instead by the browser check in Task 15 and by `pnpm test`/`pnpm lint`/`pnpm typecheck` staying green.

- [ ] **Step 1: Write `web/src/nav.js`**

```js
// The masthead's navigation — three destinations plus the external links, so
// this is markup generation with no state of its own. `render.js` decides
// which view is active from the already-parsed route; this file only draws it.

const escape = (/** @type {unknown} */ value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const GITHUB_URL = 'https://github.com/imajus/verdikt';
const X_URL = 'https://x.com/verdict402';

const GITHUB_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;
const X_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M9.53 6.78 15.17.5h-1.34L8.94 5.87 5.02.5H0l5.92 8.15L0 15.5h1.34l5.19-5.7 4.15 5.7H16L9.53 6.78Zm-1.84 2.02-.6-.83L2.3 1.44h2.06l3.84 5.29.6.83 4.99 6.87h-2.06L7.69 8.8Z"/></svg>`;

/**
 * @param {{ view: 'marketplace'|'provider'|'how', mode: 'live'|'demo' }} args
 */
export function renderNav({ view, mode }) {
  const item = (/** @type {string} */ target, /** @type {string} */ label) =>
    `<a href="?view=${target}" class="nav-item${view === target ? ' active' : ''}" data-nav="${target}">${escape(label)}</a>`;

  return `
    <nav class="nav">
      <div class="nav-links">
        ${item('marketplace', 'Marketplace')}
        ${mode === 'live' ? item('provider', 'Provider') : ''}
        ${item('how', 'How it works')}
      </div>
      <div class="nav-external">
        <a href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer" aria-label="Verdikt on GitHub">${GITHUB_ICON}</a>
        <a href="${X_URL}" target="_blank" rel="noopener noreferrer" aria-label="Verdikt on X">${X_ICON}</a>
      </div>
    </nav>`;
}
```

- [ ] **Step 2: Write `web/src/views/how-it-works.js`**

Draw the content from `docs/walkthrough.md` (read it first if not already fresh in context) — condense its narrative arc into the sections below, keeping every technical claim (two chains and why, the request path, capped refund, no dispute layer) traceable to that doc rather than invented:

```js
// A static explainer, drawn from docs/walkthrough.md — what a cold visitor
// needs before "conformance 958" on the marketplace means anything.

export function renderHowItWorks() {
  return `
    <header class="masthead">
      <div>
        <h1><a href="?">Verdikt</a></h1>
        <p class="tagline">How the verification loop works, end to end.</p>
      </div>
    </header>

    <section class="block">
      <h3>Two chains, each for one reason</h3>
      <p>
        <strong>Arc</strong> holds the registry, the escrow, the verdicts and the
        refunds — and the x402 payment itself. USDC is Arc's native gas token, so
        value moves as <code>msg.value</code>, not an ERC-20 transfer: no
        <code>approve</code>/<code>transferFrom</code>, no token address. Payment,
        bond and refund are the same asset on the same chain, which is what removes
        any cross-chain correlation between the leg an agent paid on and the leg it
        is refunded on.
      </p>
      <p>
        <strong>Ethereum Sepolia</strong> holds ENS. The SLA a provider promises
        lives only as the <code>sla</code> text record on
        <code>&lt;slug&gt;.verdikt.eth</code> — there is no SLA field on Arc at
        all. A per-key access list scopes the provider to <code>sla</code> and
        <code>url</code>, and the CRE signer to <code>conformance</code> and
        <code>availability</code>; a provider that tries to write its own score
        is refused on-chain, not by convention.
      </p>
    </section>

    <section class="block">
      <h3>What happens on a paid call</h3>
      <p>
        A proxy sits between the paying agent and the provider's own x402
        endpoint. Without a payment header, it is a plain passthrough — it only
        checks that the 402 challenge's payout address matches what the
        provider published on ENS, so an agent never signs a payment toward a
        spoofed address. With a payment attached, the call is replayed inside a
        Chainlink CRE Confidential Workflow — a TEE the provider's own response
        body passes through, evaluated against the SLA the provider itself
        published, without Verdikt or the node operators ever seeing the raw
        response outside the enclave.
      </p>
      <p>
        The workflow writes one verdict on Arc: PASS, FAIL, or DOWN (nothing
        usable came back at all). A FAIL or DOWN credits the payer from the
        service's own bonded deposit — capped at <code>min(fixed refund, what
        was actually paid, what remains of the bond)</code>, so failing on
        purpose is never profitable.
      </p>
    </section>

    <section class="block">
      <h3>Why there is no dispute layer</h3>
      <p>
        A verdict is final by design. The refund cap keeps a false FAIL from
        being worth manufacturing, and the observed value that decided a
        verdict never goes on-chain — it reaches only the agent that paid for
        it, on that agent's own response headers. Everything else — which
        clause broke, how much was refunded, a service's trailing 7-day
        conformance and availability — is public, on Arc and on ENS, and is
        exactly what this marketplace shows.
      </p>
    </section>`;
}
```

- [ ] **Step 3: Wire the nav and the how-it-works view into `web/src/render.js`**

Import `renderNav` and `renderHowItWorks` at the top of `render.js`:

```js
import { renderNav } from './nav.js';
import { renderHowItWorks } from './views/how-it-works.js';
```

Change `renderApp`'s signature and add the how-it-works branch. Current signature:
```js
export function renderApp(marketplace, mode, selectedSlug, provider = null, slaDraft = '') {
```
becomes:
```js
export function renderApp(marketplace, mode, view, selectedSlug, provider = null, slaDraft = '') {
```

At the very top of the function body, before the existing `if (provider) { ... }` branch, add:
```js
  if (view === 'how') {
    return `${renderNav({ view, mode })}${renderHowItWorks()}`;
  }
```

Prepend `renderNav({ view, mode })` to both existing return paths — the `renderProvider(...)` return and the main marketplace return — so navigation shows on every view. Since `renderProvider` and the marketplace return are template literals starting with `<header class="masthead">`, insert the nav call immediately before each:
```js
  if (provider) {
    const owned = services.filter((listing) => listing.provider.toLowerCase() === provider.toLowerCase());
    return `${renderNav({ view, mode })}${renderProvider(owned, provider, slaDraft)}`;
  }
```
and for the marketplace path, wrap the existing return value:
```js
  return `${renderNav({ view, mode })}${/* the existing template literal, unchanged */}`;
```
(Concretely: keep the existing marketplace template literal exactly as it is, and change `return \`` at its start to `return \`${renderNav({ view, mode })}` followed by the same content, closing with the same trailing backtick the function already has.)

- [ ] **Step 4: Update `web/src/main.js` to compute and pass `view`**

This will be finished properly in Task 14 (which rewires `main.js` around `router.js` end to end); for this task, make the minimal change so `renderApp`'s new required parameter does not break the existing call site. Change:
```js
root.innerHTML = renderApp(marketplace, mode, selectedSlug, provider, slaDraft);
```
to:
```js
root.innerHTML = renderApp(marketplace, mode, 'marketplace', selectedSlug, provider, slaDraft);
```
(Task 14 replaces this literal `'marketplace'` with `readRoute(new URL(location.href)).view`.)

- [ ] **Step 5: Add nav styling to `web/src/styles.css`**

Append after the `/* Masthead */` block:

```css
/* Nav ------------------------------------------------------------------------ */

.nav {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 0; font-size: 13.5px;
}
.nav-links { display: flex; gap: 20px; }
.nav-item { color: var(--muted); text-decoration: none; padding: 2px 0; border-bottom: 1.5px solid transparent; }
.nav-item:hover { color: var(--ink); }
.nav-item.active { color: var(--ink); border-bottom-color: var(--ink); }
.nav-external { display: flex; gap: 14px; align-items: center; }
.nav-external a { color: var(--muted); display: inline-flex; }
.nav-external a:hover { color: var(--ink); }
```

- [ ] **Step 6: Update `web/src/marketplace.test.js`'s calls to `renderApp`**

`marketplace.test.js` calls `renderApp(marketplace, mode, selectedSlug, ...)` directly in a few assertions (grep for `renderApp(` in that file first to find every call site). Update each to insert `'marketplace'` as the third argument, matching the new signature, e.g. `renderApp(marketplace, 'live', selectedSlug)` becomes `renderApp(marketplace, 'live', 'marketplace', selectedSlug)`.

- [ ] **Step 7: Run the full test suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 8: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add web/src/nav.js web/src/views/how-it-works.js web/src/render.js web/src/main.js web/src/styles.css web/src/marketplace.test.js
git commit -m "Add the main menu, GitHub/X links, and a how-it-works view"
```

---

### Task 12: Provider console forms — SLA editor, top-up, retire

**Files:**
- Create: `web/src/forms/sla-editor.js`
- Create: `web/src/forms/sla-editor.test.js`
- Create: `web/src/forms/bond.js`
- Create: `web/src/forms/bond.test.js`
- Modify: `web/src/render.js` (provider view mounts forms instead of the read-only calldata table)
- Modify: `web/src/styles.css`
- Modify: `web/src/marketplace.test.js` (its `renderApp` calls and three assertions on the removed calldata table)

**Interfaces:**
- Consumes: `publishSla`, `publishUrl`, `topUpBond`, `retireService` (Task 10), `walletClientFor`, `ensureChain` (Task 7), `getSession` (Task 8).
- Produces: `mountSlaEditor(container: HTMLElement, listing: Listing, deps): void`, `describeSlaValidity(source: string): { ok: boolean, message: string }`, `mountBondControls(container: HTMLElement, listing: Listing, deps): void` — the two `mount*` functions attach real DOM nodes with their own internal state, replacing the string-render + full-page-redraw approach for these two regions only.

The DOM-mounting functions (`mountSlaEditor`, `mountBondControls`) themselves have no automated test — they are thin glue over `actions.js` (already tested in Task 10) and the DOM, which this project has no component-testing precedent for. Their pure logic is factored out and tested directly instead: `describeSlaValidity` (Step 3a) and `bond.js`'s amount parser (Step 2a). The glue itself is verified by `pnpm lint`/`pnpm typecheck` and the Task 15 browser check, which exercises every button in this task by hand.

- [ ] **Step 1: Write `web/src/forms/sla-editor.js`**

```js
// The SLA editor, as a mounted DOM node rather than a re-rendered string.
//
// render.js's old provider view rebuilt the whole page on every keystroke and
// restored the caret by hand (main.js's `preserveFocus`-shaped hack, now
// gone) — a textarea that never gets destroyed needs none of that. This
// module owns exactly the elements inside its container and nothing else.

import { parseSla } from '@verdikt/sla';
import { publishSla } from '../actions.js';

/**
 * Pure: the same check `renderProvider`'s old inline validator ran, now
 * exported so it is testable on its own rather than only through a DOM.
 * Mirrors the wording the old string-rendered version used, since
 * `web/src/marketplace.test.js` documented that wording as behaviour worth
 * keeping ("accepts a valid SLA", "rejects an invalid SLA").
 * @param {string} source
 * @returns {{ ok: boolean, message: string }}
 */
export function describeSlaValidity(source) {
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, message: 'Paste an SLA to validate it.' };
  try {
    const parsed = parseSla(trimmed);
    return { ok: true, message: `Valid. ${parsed.clauses.length} clause(s); the verifier would enforce all of them.` };
  } catch (error) {
    return { ok: false, message: /** @type {Error} */ (error).message };
  }
}

/**
 * @param {HTMLElement} container an empty element this function owns completely
 * @param {{ slug: string, slaRaw: string | null }} listing
 * @param {{ walletClientFor: () => unknown, sepoliaChainConfig: object }} deps
 */
export function mountSlaEditor(container, listing, deps) {
  container.innerHTML = `
    <textarea id="sla-draft" spellcheck="false" rows="14">${escapeHtml(listing.slaRaw ?? '')}</textarea>
    <p class="check" id="sla-check"><i class="dot"></i></p>
    <button type="button" id="sla-publish" disabled>Publish SLA</button>
    <p class="form-status" id="sla-status" hidden></p>`;

  const textarea = /** @type {HTMLTextAreaElement} */ (container.querySelector('#sla-draft'));
  const check = /** @type {HTMLElement} */ (container.querySelector('#sla-check'));
  const button = /** @type {HTMLButtonElement} */ (container.querySelector('#sla-publish'));
  const status = /** @type {HTMLElement} */ (container.querySelector('#sla-status'));

  const validate = () => {
    const { ok, message } = describeSlaValidity(textarea.value);
    check.className = `check ${ok ? 'ok' : 'bad'}`;
    check.textContent = message;
    button.disabled = !ok;
  };

  textarea.addEventListener('input', validate);
  validate();

  button.addEventListener('click', async () => {
    button.disabled = true;
    status.hidden = false;
    status.textContent = 'Sending…';
    try {
      const walletClient = deps.walletClientFor();
      const { hash } = await publishSla({ walletClient, slug: listing.slug, value: textarea.value.trim() });
      status.textContent = `Sent: ${hash}`;
    } catch (error) {
      status.textContent = `Failed: ${/** @type {Error} */ (error).message}`;
    } finally {
      button.disabled = false;
    }
  });
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
```

- [ ] **Step 2: Write `web/src/forms/bond.js`**

```js
// Top-up and retire, as two small mounted forms sharing one container. Retire
// is `deregister` — one-way (VerdiktRegistry.sol: the slug can never be
// registered again) — so it is named "Retire", not "Deactivate", and gated
// behind typing the slug back.

import { retireService, topUpBond } from '../actions.js';

/**
 * @param {HTMLElement} container
 * @param {{ slug: string, serviceId: string, status: string, deposit: bigint }} listing
 * @param {{ walletClientFor: () => unknown, registryAddress: string, depositAmount: bigint, formatNativeUsdc: (v: bigint) => string }} deps
 */
export function mountBondControls(container, listing, deps) {
  const shortfall = deps.depositAmount > listing.deposit ? deps.depositAmount - listing.deposit : 0n;
  const suspended = listing.status === 'SUSPENDED';

  container.innerHTML = `
    <div class="bond-form">
      <label for="topup-amount">Top up (USDC)</label>
      <input id="topup-amount" type="text" inputmode="decimal" placeholder="0.0" />
      ${
        suspended
          ? `<p class="aside warn">Suspended — needs ${deps.formatNativeUsdc(shortfall)} more to reinstate (reinstatement requires the bond back at full, not merely above zero).</p>`
          : ''
      }
      <button type="button" id="topup-send">Top up</button>
      <p class="form-status" id="topup-status" hidden></p>
    </div>
    <div class="retire-form">
      <p class="aside warn">
        Retiring is permanent: "${escapeHtml(listing.slug)}" can never be registered again, the remaining bond
        returns to you, and the listing stops taking calls.
      </p>
      <label for="retire-confirm">Type "${escapeHtml(listing.slug)}" to confirm</label>
      <input id="retire-confirm" type="text" autocomplete="off" />
      <button type="button" id="retire-send" disabled ${suspended ? 'title="Reverts while suspended — top up first"' : ''}>Retire service</button>
      <p class="form-status" id="retire-status" hidden></p>
    </div>`;

  const topUpInput = /** @type {HTMLInputElement} */ (container.querySelector('#topup-amount'));
  const topUpButton = /** @type {HTMLButtonElement} */ (container.querySelector('#topup-send'));
  const topUpStatus = /** @type {HTMLElement} */ (container.querySelector('#topup-status'));

  topUpButton.addEventListener('click', async () => {
    const amount = parseUsdcToNativeUnits(topUpInput.value);
    if (amount === null) {
      topUpStatus.hidden = false;
      topUpStatus.textContent = 'Enter a valid amount.';
      return;
    }
    topUpButton.disabled = true;
    topUpStatus.hidden = false;
    topUpStatus.textContent = 'Sending…';
    try {
      const walletClient = deps.walletClientFor();
      const { hash } = await topUpBond({ walletClient, registryAddress: deps.registryAddress, serviceId: listing.serviceId, amount });
      topUpStatus.textContent = `Sent: ${hash}`;
    } catch (error) {
      topUpStatus.textContent = `Failed: ${/** @type {Error} */ (error).message}`;
    } finally {
      topUpButton.disabled = false;
    }
  });

  const retireInput = /** @type {HTMLInputElement} */ (container.querySelector('#retire-confirm'));
  const retireButton = /** @type {HTMLButtonElement} */ (container.querySelector('#retire-send'));
  const retireStatus = /** @type {HTMLElement} */ (container.querySelector('#retire-status'));

  retireInput.addEventListener('input', () => {
    retireButton.disabled = suspended || retireInput.value !== listing.slug;
  });

  retireButton.addEventListener('click', async () => {
    retireButton.disabled = true;
    retireStatus.hidden = false;
    retireStatus.textContent = 'Sending…';
    try {
      const walletClient = deps.walletClientFor();
      const { hash } = await retireService({ walletClient, registryAddress: deps.registryAddress, serviceId: listing.serviceId });
      retireStatus.textContent = `Sent: ${hash}`;
    } catch (error) {
      retireStatus.textContent = `Failed: ${/** @type {Error} */ (error).message}`;
      retireButton.disabled = retireInput.value !== listing.slug;
    }
  });
}

/**
 * "1.5" -> 1500000000000000000n (18-decimal native units). `null` for
 * anything that is not a plain non-negative decimal.
 * @param {string} input
 * @returns {bigint | null}
 */
function parseUsdcToNativeUnits(input) {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const paddedFraction = fraction.padEnd(18, '0').slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(paddedFraction || '0');
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
```

- [ ] **Step 2a: Add a focused unit test for the pure parsing helper**

`parseUsdcToNativeUnits` is pure and worth testing directly even though the DOM-mounting shell around it is not. Create `web/src/forms/bond.test.js`:

```js
import { describe, expect, it } from 'vitest';

// Not exported — re-implemented as a one-line re-export shim would defeat the
// point of keeping it private, so this test imports the module and reaches
// the function via a tiny re-export added below the implementation instead.
import { __parseUsdcToNativeUnitsForTests as parseUsdcToNativeUnits } from './bond.js';

describe('parseUsdcToNativeUnits', () => {
  it('parses a whole number', () => {
    expect(parseUsdcToNativeUnits('5')).toBe(5n * 10n ** 18n);
  });

  it('parses a decimal, padding to 18 places', () => {
    expect(parseUsdcToNativeUnits('1.5')).toBe(1_500_000_000_000_000_000n);
  });

  it('truncates fractions longer than 18 places rather than rejecting them', () => {
    expect(parseUsdcToNativeUnits('1.000000000000000009999')).toBe(1_000_000_000_000_000_009n);
  });

  it('rejects a negative amount', () => {
    expect(parseUsdcToNativeUnits('-1')).toBeNull();
  });

  it('rejects non-numeric input', () => {
    expect(parseUsdcToNativeUnits('abc')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(parseUsdcToNativeUnits('')).toBeNull();
  });
});
```

Add the test-only re-export at the bottom of `web/src/forms/bond.js`:
```js
export const __parseUsdcToNativeUnitsForTests = parseUsdcToNativeUnits;
```

- [ ] **Step 3: Run the new test**

Run: `pnpm vitest run web/src/forms/bond.test.js`
Expected: PASS, all 6 cases.

- [ ] **Step 3a: Add a unit test for `describeSlaValidity`**

This replaces test coverage that `web/src/marketplace.test.js` currently provides through `renderApp`'s old inline calldata table (removed in Step 4 below) — same assertions, moved to where the logic now lives. Create `web/src/forms/sla-editor.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { SLA_TEXT } from '@verdikt/fixtures';
import { describeSlaValidity } from './sla-editor.js';

describe('describeSlaValidity', () => {
  it('accepts a valid SLA and reports its clause count', () => {
    const result = describeSlaValidity(SLA_TEXT.honest);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Valid.');
  });

  it('rejects an SLA with no clauses at all — the schema requires at least one', () => {
    const result = describeSlaValidity('{"version":1,"clauses":[]}');
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('Valid.');
  });

  it('asks for an SLA when the draft is empty', () => {
    expect(describeSlaValidity('')).toEqual({ ok: false, message: 'Paste an SLA to validate it.' });
  });

  it('asks for an SLA when the draft is only whitespace', () => {
    expect(describeSlaValidity('   \n  ')).toEqual({ ok: false, message: 'Paste an SLA to validate it.' });
  });
});
```

Run: `pnpm vitest run web/src/forms/sla-editor.test.js`
Expected: PASS, all 4 cases.

- [ ] **Step 4: Rewrite the provider view in `web/src/render.js` to mount forms**

Read the current `renderProvider` function in full first (it currently ends with the read-only "Transaction to sign" calldata block). Replace the `<section class="editor block">…</section>` at the end of `renderProvider` — which today renders the textarea and calldata table inline as a string — with mount points the forms attach to:

```js
    <section class="editor block">
      <h3>SLA editor <small>${target ? escape(target.name) : ''}</small></h3>
      <p class="aside">
        Validated against the same <code>schema.json</code> the verifier enforces, so
        this cannot tell you a document is fine and then have a call judged by a
        different rule. Sent from your own wallet — Verdikt holds no key of yours,
        which is why the SLA lives on ENS and not on Arc.
      </p>
      <div id="sla-editor-mount"></div>
    </section>

    <section class="block">
      <h3>Bond <small>${target ? escape(target.name) : ''}</small></h3>
      <div id="bond-controls-mount"></div>
    </section>`;
```

Remove the parsing/calldata computation from `renderProvider` — it moves into `sla-editor.js`'s `describeSlaValidity` (Step 3a) and `mountSlaEditor`. Concretely: delete the `let check = { ok: false, message: 'Paste an SLA to validate it.' };` block, the `if (source.trim()) { try { ... } catch { ... } }` block that calls `parseSla`, the `let call = null; if (check.ok && target) { try { call = setTextCalldata(...) } catch { call = null } }` block, and the now-unused `source` variable (`const source = draft || target?.slaRaw || '';`) — the new markup above references none of `check`/`call`/`source`. `renderProvider`'s `draft` parameter itself can stay in the signature unused (this repo's eslint config sets `args: 'none'`, so an unused function argument is not a lint error) — Task 14 stops passing a meaningful value for it, always passing `''`.

Both `setTextCalldata` (from `@verdikt/sdk`) and `parseSla` (from `@verdikt/sla`) become fully unused in `render.js` once this block is gone — `renderDetail`'s clause table reads already-parsed `SlaClause` objects off `listing.sla.clauses` (shaped by `marketplace.js`'s `parseSlaOrNull`), never calling `parseSla` itself. Delete both import lines:
```js
import { setTextCalldata } from '@verdikt/sdk';
import { parseSla } from '@verdikt/sla';
```
Leaving them in place would fail `pnpm lint` (unused imports are unused *variables*, which this repo's eslint config does treat as an error even with `args: 'none'` — that setting only exempts function *arguments*).

- [ ] **Step 5: Add form styling to `web/src/styles.css`**

Append after the existing `.editor`/`textarea`/`.check` block:

```css
/* Provider console forms ------------------------------------------------------ */

button {
  font: inherit; cursor: pointer; border: 1px solid var(--rule-strong);
  background: var(--ink); color: var(--paper); border-radius: 2px;
  padding: 8px 16px; font-size: 13.5px;
}
button:hover:not(:disabled) { opacity: 0.88; }
button:disabled { cursor: not-allowed; opacity: 0.4; }
button.secondary { background: transparent; color: var(--ink); }

input[type="text"] {
  width: 100%; padding: 8px 10px; margin: 6px 0 10px;
  background: var(--paper-2); color: var(--ink);
  border: 1px solid var(--rule); border-radius: 2px;
  font-family: var(--mono); font-size: 13.5px;
}
input[type="text"]:focus { outline: 1.5px solid var(--ink); outline-offset: -1px; }
label { display: block; font-size: 13px; color: var(--muted); margin-top: 14px; }

.form-status { font-size: 13px; color: var(--ink-2); margin: 8px 0 0; font-family: var(--mono); overflow-wrap: anywhere; }
.bond-form, .retire-form { max-width: 420px; margin-top: 16px; }
.retire-form button { background: var(--poor); border-color: var(--poor); }
```

- [ ] **Step 5a: Fix `web/src/marketplace.test.js`'s now-broken `renderApp` calls**

Two things break it: Task 11 inserted a required `view` parameter as `renderApp`'s 3rd argument, and this Step 4 deleted the inline calldata-table markup three of its tests assert on directly (that coverage moved to Step 3a's `sla-editor.test.js`).

First, insert `view` into every `renderApp(` call. The marketplace-view call (around line 281):
```js
    const html = renderApp(await build(), 'demo', 'weather');
```
becomes:
```js
    const html = renderApp(await build(), 'demo', 'marketplace', 'weather');
```

The four provider-view calls that stay (around lines 372, 378, 384, 389) each change from this shape:
```js
    const html = renderApp(await build(), 'demo', null, '0xA11ce00000000000000000000000000000000001');
```
to:
```js
    const html = renderApp(await build(), 'demo', 'provider', null, '0xA11ce00000000000000000000000000000000001');
```
(same for the `'0xa11ce...'` case-insensitivity call and the `'0xdead'` "owns nothing" call — insert `'provider'` as the 3rd argument in each, `selectedSlug` staying `null`.)

Second, delete the three tests whose whole point was the inline calldata table this task just removed — `'accepts a valid SLA and offers the transaction to sign'`, `'rejects an invalid SLA and never offers a transaction for it'`, and `'never offers to send anything itself — Verdikt holds no provider key'` (the `describe('the provider view', …)` block's last three `it(...)` cases, which assert `'Valid.'`, `'setText(bytes32,string,string)'` and `'Nothing is sent'`). Their assertions describe behavior that has moved to `web/src/forms/sla-editor.test.js` (Step 3a) — the third one's claim is no longer even true: the whole point of this task is that a signed-in provider's own wallet *does* now send the transaction, so asserting "Nothing is sent" against the new markup would be asserting a falsehood, not a stale detail.

- [ ] **Step 6: Run the full test suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 7: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add web/src/forms/sla-editor.js web/src/forms/sla-editor.test.js web/src/forms/bond.js web/src/forms/bond.test.js web/src/render.js web/src/styles.css web/src/marketplace.test.js
git commit -m "Replace the read-only SLA editor with a wallet-signed provider console"
```

---

### Task 13: Onboarding wizard — new service, three steps

**Files:**
- Create: `web/src/forms/wizard.js`
- Modify: `web/src/render.js` (mount point on the provider view when there is nothing to show yet, or a persistent "add a service" entry point)
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `claimSubname`, `registerService`, `publishSla`, `publishUrl` (Task 10), `walletClientFor`, `ensureChain` (Task 7), `parseSla` (`@verdikt/sla`), `readNameState`-equivalent read (see Step 1 note below).

- [ ] **Step 1: Decide the availability check's data source**

The wizard's step 1 needs to check whether a slug is already claimed before letting the provider submit. `readNameState` (in `scripts/ens-sepolia.mjs`) is registrar/EAC-onboarding surface that must not leak into `web` (CLAUDE.md: "the scripts... would otherwise duplicate every address and ABI fragment twice over"). Instead, reuse what already crossed the choke point: `resolveServiceRecord(slug).owner` (Task 4) — `owner !== null` means claimed. This is one extra network read the wizard already needs anyway (it must resolve the slug to show a live "already claimed" state), so no new ENS surface is added to `web`.

- [ ] **Step 2: Write `web/src/forms/wizard.js`**

```js
// New-service onboarding: three wallet-signed transactions, ENS before Arc.
//
// ENS first is deliberate (docs/superpowers/specs/2026-09-08-provider-console-design.md
// §5): by the time the Arc registration happens, the subname already exists
// and already agrees with the caller, so the proxy's ownership check
// (checkOwnership) can never flag a service this wizard just created.
//
// State is derived from the two chains on every render rather than kept in
// localStorage: a refresh or a dropped wallet mid-flow re-enters at whichever
// step the chains say is next, because that IS the state.

import { resolveServiceRecord } from '@verdikt/sdk';
import { parseSla } from '@verdikt/sla';
import { claimSubname, publishSla, publishUrl, registerService } from '../actions.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * @param {HTMLElement} container
 * @param {{
 *   account: string,
 *   registrarAddress: string,
 *   registryAddress: string,
 *   depositAmount: bigint,
 *   sepoliaRpcUrl: string,
 *   formatNativeUsdc: (v: bigint) => string,
 *   walletClientFor: () => unknown,
 *   ensureSepolia: () => Promise<void>,
 *   ensureArc: () => Promise<void>,
 *   onDone: () => void
 * }} deps
 */
export function mountWizard(container, deps) {
  /** @type {{ step: 1|2|3, slug: string, claimed: boolean|null, registered: boolean|null }} */
  const state = { step: 1, slug: '', claimed: null, registered: null };

  const draw = () => {
    container.innerHTML = `
      <ol class="wizard-steps">
        <li class="${state.step >= 1 ? 'done' : ''}">1. Claim the subname</li>
        <li class="${state.step >= 2 ? 'done' : ''}">2. Register on Arc</li>
        <li class="${state.step >= 3 ? 'done' : ''}">3. Publish SLA &amp; URL</li>
      </ol>
      <div id="wizard-step"></div>`;
    const stepMount = /** @type {HTMLElement} */ (container.querySelector('#wizard-step'));
    if (state.step === 1) drawStep1(stepMount);
    else if (state.step === 2) drawStep2(stepMount);
    else drawStep3(stepMount);
  };

  /** @param {HTMLElement} mount */
  const drawStep1 = (mount) => {
    mount.innerHTML = `
      <label for="wizard-slug">Slug</label>
      <input id="wizard-slug" type="text" autocomplete="off" value="${state.slug}" placeholder="weather" />
      <p class="form-status" id="wizard-availability" hidden></p>
      <button type="button" id="wizard-claim" disabled>Claim on Sepolia</button>
      <p class="form-status" id="wizard-status" hidden></p>`;

    const input = /** @type {HTMLInputElement} */ (mount.querySelector('#wizard-slug'));
    const availability = /** @type {HTMLElement} */ (mount.querySelector('#wizard-availability'));
    const claimButton = /** @type {HTMLButtonElement} */ (mount.querySelector('#wizard-claim'));
    const status = /** @type {HTMLElement} */ (mount.querySelector('#wizard-status'));

    let checkToken = 0;
    const checkAvailability = async () => {
      const slug = input.value.trim();
      const token = ++checkToken;
      if (!SLUG.test(slug)) {
        availability.hidden = false;
        availability.textContent = 'Lowercase letters, digits and hyphens only.';
        claimButton.disabled = true;
        return;
      }
      availability.hidden = false;
      availability.textContent = 'Checking…';
      claimButton.disabled = true;
      try {
        // rpcUrl must be passed explicitly and truthy: packages/sdk/ens.js
        // falls back to packages/sdk/env.js's env(), which reads
        // `process.env` directly — undefined in a Vite browser bundle, so an
        // omitted rpcUrl here would throw ReferenceError: process is not
        // defined the moment a slug is typed. web/src/source.js already
        // avoids this the same way, for the same reason.
        const record = await resolveServiceRecord(slug, { rpcUrl: deps.sepoliaRpcUrl });
        if (token !== checkToken) return;
        if (record.owner) {
          availability.textContent = `Already claimed by ${record.owner}.`;
          claimButton.disabled = true;
        } else {
          availability.textContent = 'Available.';
          claimButton.disabled = false;
        }
      } catch (error) {
        if (token !== checkToken) return;
        availability.textContent = `Could not check availability: ${/** @type {Error} */ (error).message}`;
        claimButton.disabled = true;
      }
    };

    input.addEventListener('input', () => {
      state.slug = input.value.trim();
      checkAvailability();
    });

    claimButton.addEventListener('click', async () => {
      claimButton.disabled = true;
      status.hidden = false;
      status.textContent = 'Sending…';
      try {
        await deps.ensureSepolia();
        const walletClient = deps.walletClientFor();
        await claimSubname({ walletClient, registrarAddress: deps.registrarAddress, slug: state.slug, payTo: deps.account });
        state.step = 2;
        draw();
      } catch (error) {
        status.textContent = `Failed: ${/** @type {Error} */ (error).message}`;
        claimButton.disabled = false;
      }
    });
  };

  /** @param {HTMLElement} mount */
  const drawStep2 = (mount) => {
    mount.innerHTML = `
      <p class="aside">Registering "${state.slug}" for ${deps.formatNativeUsdc(deps.depositAmount)}.</p>
      <button type="button" id="wizard-register">Register on Arc</button>
      <p class="form-status" id="wizard-status" hidden></p>`;
    const button = /** @type {HTMLButtonElement} */ (mount.querySelector('#wizard-register'));
    const status = /** @type {HTMLElement} */ (mount.querySelector('#wizard-status'));

    button.addEventListener('click', async () => {
      button.disabled = true;
      status.hidden = false;
      status.textContent = 'Sending…';
      try {
        await deps.ensureArc();
        const walletClient = deps.walletClientFor();
        await registerService({ walletClient, registryAddress: deps.registryAddress, slug: state.slug, depositAmount: deps.depositAmount });
        state.step = 3;
        draw();
      } catch (error) {
        status.textContent = `Failed: ${/** @type {Error} */ (error).message}`;
        button.disabled = false;
      }
    });
  };

  /** @param {HTMLElement} mount */
  const drawStep3 = (mount) => {
    mount.innerHTML = `
      <label for="wizard-url">Endpoint URL</label>
      <input id="wizard-url" type="text" autocomplete="off" placeholder="https://provider.example/api" />
      <label for="wizard-sla">SLA (JSON)</label>
      <textarea id="wizard-sla" spellcheck="false" rows="10"></textarea>
      <p class="check bad" id="wizard-sla-check"><i class="dot"></i>Paste an SLA to validate it.</p>
      <button type="button" id="wizard-publish" disabled>Publish &amp; finish</button>
      <p class="form-status" id="wizard-status" hidden></p>`;

    const urlInput = /** @type {HTMLInputElement} */ (mount.querySelector('#wizard-url'));
    const slaInput = /** @type {HTMLTextAreaElement} */ (mount.querySelector('#wizard-sla'));
    const check = /** @type {HTMLElement} */ (mount.querySelector('#wizard-sla-check'));
    const button = /** @type {HTMLButtonElement} */ (mount.querySelector('#wizard-publish'));
    const status = /** @type {HTMLElement} */ (mount.querySelector('#wizard-status'));

    const validate = () => {
      const source = slaInput.value.trim();
      const urlOk = /^https?:\/\//.test(urlInput.value.trim());
      if (!source) {
        check.className = 'check bad';
        check.textContent = 'Paste an SLA to validate it.';
        button.disabled = true;
        return;
      }
      try {
        const parsed = parseSla(source);
        check.className = 'check ok';
        check.textContent = `Valid. ${parsed.clauses.length} clause(s).`;
        button.disabled = !urlOk;
      } catch (error) {
        check.className = 'check bad';
        check.textContent = /** @type {Error} */ (error).message;
        button.disabled = true;
      }
    };
    urlInput.addEventListener('input', validate);
    slaInput.addEventListener('input', validate);

    button.addEventListener('click', async () => {
      button.disabled = true;
      status.hidden = false;
      status.textContent = 'Publishing URL…';
      try {
        await deps.ensureSepolia();
        const walletClient = deps.walletClientFor();
        await publishUrl({ walletClient, slug: state.slug, value: urlInput.value.trim() });
        status.textContent = 'Publishing SLA…';
        await publishSla({ walletClient, slug: state.slug, value: slaInput.value.trim() });
        status.textContent = 'Done.';
        deps.onDone();
      } catch (error) {
        status.textContent = `Failed: ${/** @type {Error} */ (error).message}`;
        button.disabled = false;
      }
    });
  };

  draw();
}
```

- [ ] **Step 3: Mount the wizard from `web/src/render.js`**

In `renderProvider`, add an "Add a service" entry point near the top of the function's returned markup (right after the `<header class="masthead">…</header>` block, before the `<section class="figures">`):

```js
    <section class="block">
      <h3>Add a service</h3>
      <div id="wizard-mount"></div>
    </section>
```

- [ ] **Step 4: Add wizard styling to `web/src/styles.css`**

```css
/* Onboarding wizard ------------------------------------------------------------ */

.wizard-steps { display: flex; gap: 24px; list-style: none; padding: 0; margin: 0 0 16px; font-size: 13px; color: var(--muted); }
.wizard-steps li.done { color: var(--good); font-weight: 500; }
```

- [ ] **Step 5: Run the full test suite, lint and typecheck**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: all clean. (No new automated tests in this task beyond what Task 10's `actions.test.js` and Task 4's `ens.test.js` already cover for everything this wizard calls — its own correctness is exercised by hand in Task 15.)

- [ ] **Step 6: Commit**

```bash
git add web/src/forms/wizard.js web/src/render.js web/src/styles.css
git commit -m "Add the three-step new-service onboarding wizard"
```

---

### Task 14: Wire the wallet, session, router and mounted forms into `main.js`

**Files:**
- Modify: `web/src/main.js`

**Interfaces:**
- Consumes: everything from Tasks 7–13.
- Produces: a working end-to-end page — connect, sign in, navigate, and every mounted form actually attached after each render.

This is integration glue, verified by the Task 15 browser check plus the full test suite (no new isolated unit test — `main.js` has none today either, since it is exactly the kind of top-level wiring `render.js`'s own tests already exercise the pieces of).

- [ ] **Step 1: Read the current `web/src/main.js` in full again** (it was already read at the start of this project; re-read it now since Task 11 changed one line in it) to get exact current line numbers before editing.

- [ ] **Step 2: Rewrite `web/src/main.js`**

```js
import { ARC, SEPOLIA, registryAbi } from '@verdikt/sdk';
import { byReputation, loadMarketplace } from './marketplace.js';
import { formatNativeUsdc } from './format.js';
import { renderApp } from './render.js';
import { readRoute, withService, withView } from './router.js';
import { createSource } from './source.js';
import { connectWallet, ensureChain, getConnectedAccount, onAccountChange, walletClientFor } from './wallet.js';
import { getSession, signIn } from './session.js';
import { mountSlaEditor } from './forms/sla-editor.js';
import { mountBondControls } from './forms/bond.js';
import { mountWizard } from './forms/wizard.js';

const root = /** @type {HTMLElement} */ (document.getElementById('app'));
// Vite injects the env; `import.meta.env` is not in the shared jsconfig's lib.
const { mode, deps } = createSource(/** @type {any} */ (import.meta).env ?? {});

const ARC_CHAIN_CONFIG = { chainId: ARC.chainId, name: 'Arc Testnet', rpcUrl: 'https://rpc.testnet.arc.network', nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 } };
const SEPOLIA_CHAIN_CONFIG = { chainId: SEPOLIA.chainId, name: 'Ethereum Sepolia', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com' };

/** @type {import('./marketplace.js').Marketplace | null} */
let marketplaceCache = null;
/**
 * Read live from the registry rather than hardcoded: DEPOSIT_AMOUNT is a
 * constructor argument on VerdiktRegistry (contracts/src/VerdiktRegistry.sol),
 * not a fixed value, and a wizard that guessed it wrong would either
 * under-fund a registration (reverts: IncorrectDeposit) or over-charge a
 * provider by however much the guess was off.
 * @type {bigint | null}
 */
let depositAmountCache = null;

async function main() {
  root.innerHTML = '<p class="empty">Reading Arc and the naming layer…</p>';
  try {
    marketplaceCache = await loadMarketplace(deps);
    marketplaceCache.services.sort(byReputation);
    // Only meaningful in live mode — demo mode's registry stub exposes no
    // .client/.address (web/src/source.js), and the Provider tab is hidden
    // there anyway, so nothing ever reads depositAmountCache in demo mode.
    if (mode === 'live') {
      depositAmountCache = await /** @type {any} */ (deps.registry).client.readContract({
        address: /** @type {any} */ (deps.registry).address,
        abi: registryAbi,
        functionName: 'DEPOSIT_AMOUNT'
      });
    }
    draw();
  } catch (error) {
    root.innerHTML = `<p class="note warn">Could not load the marketplace: ${/** @type {Error} */ (error).message}</p>`;
  }
}

function draw() {
  const marketplace = /** @type {import('./marketplace.js').Marketplace} */ (marketplaceCache);
  const route = readRoute(new URL(location.href));
  const selected = marketplace.services.find((listing) => listing.slug === route.service) ?? marketplace.services[0] ?? null;

  root.innerHTML = renderApp(marketplace, mode, route.view, selected?.slug ?? null, route.provider, '');

  for (const row of root.querySelectorAll('.row[data-slug]')) {
    row.addEventListener('click', () => {
      const slug = /** @type {HTMLElement} */ (row).dataset.slug ?? null;
      if (slug) {
        // Keeps a service's page linkable — the point of a marketplace is that
        // someone can send you the listing they are looking at.
        history.replaceState(null, '', withService(new URL(location.href), String(slug)));
        draw();
      }
    });
  }

  for (const link of root.querySelectorAll('.nav-item[data-nav]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const target = /** @type {HTMLElement} */ (link).dataset.nav ?? 'marketplace';
      history.replaceState(null, '', withView(new URL(location.href), target));
      draw();
    });
  }

  if (route.view === 'provider' && mode === 'live') {
    mountProviderConsole(route, selected);
  }
}

/**
 * @param {ReturnType<typeof readRoute>} route
 * @param {import('./marketplace.js').Listing | null} selected
 */
function mountProviderConsole(route, selected) {
  const account = getConnectedAccount();
  const session = getSession();
  const viewingOwnPage = Boolean(account && route.provider && account.address.toLowerCase() === route.provider.toLowerCase());
  // Set in main() before draw() is ever called in live mode — see the guard
  // in main() above. Not null here.
  const depositAmount = /** @type {bigint} */ (depositAmountCache);

  const wizardMount = root.querySelector('#wizard-mount');
  if (wizardMount && account && session && viewingOwnPage) {
    mountWizard(/** @type {HTMLElement} */ (wizardMount), {
      account: account.address,
      registrarAddress: /** @type {string} */ (SEPOLIA.subnameRegistrar),
      registryAddress: /** @type {string} */ (ARC.registry),
      depositAmount,
      sepoliaRpcUrl: SEPOLIA_CHAIN_CONFIG.rpcUrl,
      formatNativeUsdc,
      walletClientFor: () => walletClientFor(ARC_CHAIN_CONFIG),
      ensureSepolia: () => ensureChain(SEPOLIA.chainId, SEPOLIA_CHAIN_CONFIG),
      ensureArc: () => ensureChain(ARC.chainId, ARC_CHAIN_CONFIG),
      onDone: () => main()
    });
  } else if (wizardMount) {
    wizardMount.innerHTML = account
      ? '<p class="aside">Connect as this provider\'s own address to add a service.</p>'
      : '<p class="aside">Connect a wallet to add a service.</p>';
  }

  if (!selected) return;

  const slaMount = root.querySelector('#sla-editor-mount');
  if (slaMount && account && session && viewingOwnPage) {
    mountSlaEditor(/** @type {HTMLElement} */ (slaMount), selected, {
      walletClientFor: () => walletClientFor(SEPOLIA_CHAIN_CONFIG),
      sepoliaChainConfig: SEPOLIA_CHAIN_CONFIG
    });
  } else if (slaMount) {
    slaMount.innerHTML = '<p class="aside">Connect as this service\'s own provider to publish changes.</p>';
  }

  const bondMount = root.querySelector('#bond-controls-mount');
  if (bondMount && account && session && viewingOwnPage) {
    mountBondControls(/** @type {HTMLElement} */ (bondMount), selected, {
      walletClientFor: () => walletClientFor(ARC_CHAIN_CONFIG),
      registryAddress: /** @type {string} */ (ARC.registry),
      depositAmount,
      formatNativeUsdc
    });
  } else if (bondMount) {
    bondMount.innerHTML = '<p class="aside">Connect as this service\'s own provider to manage its bond.</p>';
  }
}

onAccountChange(() => draw());

document.addEventListener('click', async (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (target.id !== 'connect-wallet') return;
  event.preventDefault();
  try {
    const account = await connectWallet();
    await signIn(SEPOLIA.chainId, {
      address: account.address,
      walletClient: walletClientFor(SEPOLIA_CHAIN_CONFIG),
      domain: location.host,
      origin: location.origin
    });
    draw();
  } catch (error) {
    // eslint-disable-next-line no-console -- the only place this surfaces; there is no toast system.
    console.error('sign-in failed:', /** @type {Error} */ (error).message);
  }
});

main();
```

- [ ] **Step 3: Add a "Connect wallet" button to the nav in `web/src/render.js`/`web/src/nav.js`**

Extend `renderNav` (Task 11) to show a connect affordance. Since `nav.js` renders pure markup with no access to wallet state, pass the current session address in:

```js
/**
 * @param {{ view: 'marketplace'|'provider'|'how', mode: 'live'|'demo', account?: string|null }} args
 */
export function renderNav({ view, mode, account = null }) {
```
and append inside `.nav-external`, before the closing `</div>`:
```js
        ${
          mode === 'live'
            ? account
              ? `<span class="nav-account" title="${escape(account)}">${escape(account.slice(0, 6))}…${escape(account.slice(-4))}</span>`
              : `<button type="button" id="connect-wallet" class="secondary">Connect wallet</button>`
            : ''
        }
```

Update `render.js`'s three call sites of `renderNav({ view, mode })` to pass account too:
```js
renderNav({ view, mode, account: getConnectedAccount()?.address ?? null })
```
This requires `render.js` to import `getConnectedAccount` from `./wallet.js` — add that import at the top of `render.js`.

- [ ] **Step 4: Add nav-account styling to `web/src/styles.css`**

```css
.nav-account { font-family: var(--mono); font-size: 12.5px; color: var(--ink-2); }
```

- [ ] **Step 5: Run the full test suite, lint and typecheck**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/main.js web/src/render.js web/src/nav.js web/src/styles.css
git commit -m "Wire the wallet, session, router and provider forms into the dashboard"
```

---

### Task 15: Manual browser verification

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

Run: `cd web && pnpm dev` (background — leave it running)
Expected: Vite prints a local URL, typically `http://localhost:5173`.

- [ ] **Step 2: Open the page and check the marketplace view**

Use the `mcp__chrome-devtools__navigate_page`/`new_page` tool to open `http://localhost:5173/`. Take a snapshot (`mcp__chrome-devtools__take_screenshot`). Confirm: the masthead shows the new nav (Marketplace / How it works — Provider is absent, since demo mode has no `VITE_ARC_RPC_URL` configured), GitHub and X icons are present and link out correctly, and the existing marketplace list/detail panel still renders as before.

- [ ] **Step 3: Check the how-it-works view**

Click "How it works" (or navigate to `?view=how`). Confirm the explainer content renders, nav stays visible, and the page has no console errors (`mcp__chrome-devtools__list_console_messages`).

- [ ] **Step 4: Confirm the Provider tab is genuinely absent in demo mode**

Navigate to `?view=provider` directly. Since `mode === 'demo'`, `main.js`'s `mountProviderConsole` is gated on `mode === 'live'` and never runs — confirm the page does not throw and does not attempt to mount any wallet-dependent form (check the console for errors referencing `wallet.js`/`actions.js`).

- [ ] **Step 5: Check for regressions in existing interactions**

Click a few service rows, confirm `?service=` updates and the detail panel switches, exactly as before this work.

- [ ] **Step 6: Record what was and wasn't checked live**

Wallet-connected flows (connect, SIWE sign-in, claim/register/publish/top-up/retire transactions) cannot be exercised in this browser session without a live-chain RPC, a funded test wallet, and a deployed `VerdiktSubnameRegistrar` (Task 3's live deployment and role grants are explicitly out of scope for this session — no funded operator key is available here). Their correctness is covered by: `wallet.test.js`/`session.test.js`/`actions.test.js` (Tasks 7, 8, 10) against fake providers/wallet clients, and `VerdiktSubnameRegistrar.t.sol` (Task 2) against a Foundry-simulated registry/resolver. Note this explicitly in the PR description (Task 16) rather than silently claiming full manual coverage.

- [ ] **Step 7: Stop the dev server**

Close the background dev server process.

---

### Task 16: Final full-suite verification and PR

**Files:** none.

- [ ] **Step 1: Run every check the repo defines**

```bash
pnpm lint
pnpm typecheck
pnpm test
cd contracts && forge fmt --check && forge build && forge test
cd ..
```
Expected: all green. Fix anything red before proceeding — do not open a PR on a red suite.

- [ ] **Step 2: Review the full diff**

```bash
git status
git log --oneline main..HEAD
git diff main..HEAD --stat
```
Confirm no stray files (`.env`, personal RPC keys, editor artifacts) are staged anywhere in the range.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "Add a provider console with wallet-signed self-serve onboarding" --body "$(cat <<'EOF'
## Summary
- Adds a main menu (Marketplace / Provider / How it works) plus GitHub and X links to the dashboard masthead.
- Adds a client-side SIWE sign-in and a provider console where a connected wallet signs its own transactions: publish an SLA, top up a bond, retire a service (`deregister` — permanent, named as such), or onboard a brand-new one through a three-step wizard.
- Adds `VerdiktSubnameRegistrar`, a permissionless Sepolia contract that does in one `claim()` call what `scripts/onboard-service.mjs` previously required an operator to run by hand — verified against the live ENSv2 bytecode (Sourcify) rather than assumed.
- A permissionless registrar means the ENS side and the Arc side of a slug are independent first-come claims; the proxy now refuses to route a slug where they disagree (`checkOwnership`), and the marketplace flags such a listing as contested.

## Not done in this PR
- `VerdiktSubnameRegistrar` is not yet deployed to live Sepolia and has not been granted its operator roles — that needs a funded operator key this session does not have. `deployments/sepolia.json`'s `subnameRegistrar` stays `null` until `contracts/script/DeployRegistrar.s.sol` and `scripts/grant-registrar-roles.mjs --send` are run for real; the provider console degrades to "connect a wallet" prompts until then.
- Wallet-connected flows are covered by unit tests against fake providers/wallet clients and by the registrar's Foundry tests, not by an end-to-end live-chain run — see the design doc's manual-verification notes.

## Test plan
- [x] `pnpm lint && pnpm typecheck && pnpm test`
- [x] `forge fmt --check && forge build && forge test` in `contracts/`
- [x] Manual browser check of the marketplace and how-it-works views in demo mode
- [ ] Live-chain check of the provider console, once the registrar is deployed and role-granted
EOF
)"
```

Return the PR URL.
