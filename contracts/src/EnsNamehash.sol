// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EnsNamehash
/// @notice ENSIP-1 `namehash`, so a deployment derives its parent node from the
///         parent *name* instead of taking a pre-computed hash on trust.
///
/// @dev Deploy-time only — nothing on the hot path calls this.
///      `VerdiktScoreWriter` still stores the resulting `bytes32` immutably and
///      derives child nodes with one `keccak256`, which is the cheap operation.
///
///      **Why this exists rather than an `ENS_PARENT_NODE` env var.** A
///      pre-computed hash is a second source of truth for a value already
///      implied by `ENS_PARENT_NAME`, and the failure it invites is silent: a
///      namehash of the wrong name is still a perfectly well-formed `bytes32`,
///      so the score writer would deploy happily and then be unable to write
///      anything, with nothing in the configuration to point at.
///
///      **The normalisation caveat, which is the reason to be careful here.**
///      ENSIP-15 requires labels to be UTS-46 normalised before hashing, and
///      that is not implementable in Solidity at any sensible cost. This
///      library therefore refuses anything that is not already normalised: it
///      accepts only lowercase ASCII letters, digits and hyphens, separated by
///      single dots. For those inputs normalisation is the identity function,
///      so the result is exactly what a full implementation would produce.
///      Anything else reverts rather than returning a plausible wrong answer.
///
///      That restriction costs nothing here: `VerdiktRegistry` already
///      constrains a slug to the same character set, because one slug is also a
///      DNS label and an ENS label.
library EnsNamehash {
    error EmptyName();
    error EmptyLabel(string name);
    error UnnormalisedName(string name);

    /// @param name e.g. "verdikt.eth". Must already be normalised — see above.
    /// @return node the ENSIP-1 namehash.
    function namehash(string memory name) internal pure returns (bytes32 node) {
        bytes memory raw = bytes(name);
        if (raw.length == 0) revert EmptyName();
        _assertNormalised(raw, name);

        // ENSIP-1 is defined right to left:
        //   namehash([]) = 0x00…00
        //   namehash([label, …rest]) = keccak256(namehash(rest) ‖ keccak256(label))
        // so walk backwards, hashing each label as its start is found.
        node = bytes32(0);
        uint256 end = raw.length;
        for (uint256 i = raw.length; i > 0; --i) {
            if (raw[i - 1] == ".") {
                node = keccak256(abi.encodePacked(node, _labelhash(raw, i, end)));
                end = i - 1;
            }
        }
        node = keccak256(abi.encodePacked(node, _labelhash(raw, 0, end)));
    }

    /// @dev keccak256 of `raw[start:end]`, without allocating a substring twice.
    function _labelhash(bytes memory raw, uint256 start, uint256 end) private pure returns (bytes32) {
        if (end <= start) revert EmptyLabel(string(raw));
        bytes memory label = new bytes(end - start);
        for (uint256 i = 0; i < label.length; ++i) {
            label[i] = raw[start + i];
        }
        return keccak256(label);
    }

    /// @dev Lowercase ASCII alphanumerics, hyphens and dots only. Everything
    ///      else — uppercase, unicode, an empty label — would need UTS-46 to
    ///      hash correctly, so it is refused instead of guessed at.
    function _assertNormalised(bytes memory raw, string memory name) private pure {
        if (raw[0] == "." || raw[raw.length - 1] == ".") revert EmptyLabel(name);
        for (uint256 i = 0; i < raw.length; ++i) {
            bytes1 c = raw[i];
            bool ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-" || c == ".";
            if (!ok) revert UnnormalisedName(name);
            if (c == "." && i > 0 && raw[i - 1] == ".") revert EmptyLabel(name);
        }
    }
}
