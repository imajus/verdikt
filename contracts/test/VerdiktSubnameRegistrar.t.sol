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

    function register(
        string calldata label,
        address owner,
        address,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256) {
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
        registrar =
            new VerdiktSubnameRegistrar(address(registry), address(resolver), scoreWriter, PARENT_NAME, DURATION);
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
