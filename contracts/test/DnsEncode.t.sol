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
