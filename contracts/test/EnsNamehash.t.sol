// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EnsNamehash} from "../src/EnsNamehash.sol";

/// @dev Every expected value here was computed by viem's `namehash` — the same
///      implementation `packages/sdk` and `scripts/setup-ens.mjs` resolve names
///      with. That is the whole point: this library exists so a deploy derives
///      the node the rest of the repo would derive, and a divergence would ship
///      a score writer that publishes to a name nobody resolves.
contract EnsNamehashTest is Test {
    function test_matchesViemOnTheNamesVerdiktUses() public pure {
        assertEq(
            EnsNamehash.namehash("verdikt.eth"), 0x6c1b597e35b4df6aac8803fe2037cd4060554e5de1451fe72adaa2daf783efc1
        );
        assertEq(
            EnsNamehash.namehash("weather.verdikt.eth"),
            0x7e157d72c57f3533bd7a6b4d9ab667703fd2aa59ad5f14959dfd6ac663366809
        );
    }

    function test_matchesViemOnTheStructuralCases() public pure {
        assertEq(EnsNamehash.namehash("eth"), 0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae);
        // Three labels, to prove the right-to-left fold rather than a special
        // case that happens to work at two.
        assertEq(EnsNamehash.namehash("a.b.c"), 0x257d8d183501fdaabc229b5b3b63dc77d8dc3685dc5623e91f472e7f2e443c5a);
    }

    /// @dev The failure being guarded against is silent: hashing an
    ///      un-normalised name yields a perfectly well-formed bytes32 that
    ///      resolves to nothing, so the score writer would deploy without
    ///      complaint and then publish into the void.
    function test_refusesNamesItCannotFaithfullyHash() public {
        // Uppercase and unicode both need UTS-46 folding; underscore is not a
        // legal label character at all. The allowlist matches the slug rule in
        // VerdiktRegistry, because one slug is also a DNS and an ENS label.
        string[4] memory unnormalised = ["Verdikt.eth", "VERDIKT.ETH", unicode"vérdikt.eth", "verdikt_x.eth"];
        for (uint256 i = 0; i < unnormalised.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(EnsNamehash.UnnormalisedName.selector, unnormalised[i]));
            this.namehash(unnormalised[i]);
        }
    }

    function test_refusesEmptyLabels() public {
        string[3] memory malformed = [".eth", "verdikt.", "verdikt..eth"];
        for (uint256 i = 0; i < malformed.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(EnsNamehash.EmptyLabel.selector, malformed[i]));
            this.namehash(malformed[i]);
        }
    }

    /// @dev ENSIP-1 defines the empty name as the zero node, but as a *parent
    ///      name* it is a configuration mistake, so it is refused rather than
    ///      silently rooting every subname at 0x00.
    function test_refusesTheEmptyName() public {
        vm.expectRevert(EnsNamehash.EmptyName.selector);
        this.namehash("");
    }

    /// @dev `vm.expectRevert` needs an external call to observe.
    function namehash(string calldata name) external pure returns (bytes32) {
        return EnsNamehash.namehash(name);
    }
}
