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
