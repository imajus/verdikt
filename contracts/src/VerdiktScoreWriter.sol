// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReportReceiver} from "./ReportReceiver.sol";

interface IPermissionedResolver {
    function setText(bytes32 node, string calldata key, string calldata value) external;
}

/// @title VerdiktScoreWriter
/// @notice Publishes the hourly conformance and availability ratios to a
///         service's `<slug>.verdikt.eth` subname, on Sepolia.
///
/// @dev **Why this contract exists at all.** Specification.md §2 says the hourly
///      workflow "writes both to ENS". It cannot do that directly: a CRE
///      workflow holds no key and sends no transaction, and its only on-chain
///      write is a DON-signed report delivered to an `IReceiver` (Spike B,
///      CRE-2). An ENS resolver is not an `IReceiver`. So the workflow writes a
///      report *here*, and this contract — which does hold the EAC roles — calls
///      `setText`.
///
///      That relocates the "CRE signer scoped to the conformance/availability
///      keys" from §4 onto this address: onboarding grants it
///      `authorizeTextRoles(name, "conformance", scoreWriter, true)` and the
///      same for `availability`, and nothing else. Spike A confirmed writing any
///      other key then reverts with `EACUnauthorizedAccountRoles`, so the ACL
///      argument for choosing ENSv2 survives the indirection intact — the
///      provider still owns `sla` and `url`, and this contract can never touch
///      them.
///
///      The report carries the **slug**, not a node. The node is derived here
///      from an immutable parent, so a report can only ever address a child of
///      `verdikt.eth` — never the parent itself, and never some unrelated name
///      the resolver happens to serve.
contract VerdiktScoreWriter is ReportReceiver {
    /// @notice The PermissionedResolver serving `<slug>.verdikt.eth`.
    IPermissionedResolver public immutable RESOLVER;
    /// @notice namehash("verdikt.eth"). Every write is a child of this.
    bytes32 public immutable PARENT_NODE;

    /// @dev Matches `@verdikt/sla`'s 0–1000 integer scale. A value above it
    ///      could only come from a bug in the aggregate, and publishing it would
    ///      rank a service above a perfect one.
    uint256 public constant MAX_SCORE = 1000;

    error ScoreOutOfRange(uint256 score);
    error EmptySlug();

    event ScoresPublished(bytes32 indexed node, string slug, uint256 conformance, uint256 availability);

    constructor(address forwarder, address workflowOwner, bytes10 workflowName, address resolver, bytes32 parentNode)
        ReportReceiver(forwarder, workflowOwner, workflowName)
    {
        require(resolver != address(0), "resolver=0");
        require(parentNode != bytes32(0), "parentNode=0");
        RESOLVER = IPermissionedResolver(resolver);
        PARENT_NODE = parentNode;
    }

    /// @notice Report shape: `abi.encode(string slug, uint256 conformance, uint256 availability)`.
    /// @dev Mirrored in `cre/workflows/aggregate/workflow.ts`.
    ///
    ///      Unlike `VerdiktRegistry.onReport`, everything here reverts on bad
    ///      input rather than emitting a rejection. A score is display-only and
    ///      is overwritten on the next hourly run (Specification.md §1), so a
    ///      dropped write costs a stale number and no reconciliation — there is
    ///      no silent-failure hazard worth an extra code path.
    function onReport(bytes calldata metadata, bytes calldata report) external {
        _authenticateReport(metadata);

        (string memory slug, uint256 conformance, uint256 availability) = abi.decode(report, (string, uint256, uint256));

        if (bytes(slug).length == 0) revert EmptySlug();
        if (conformance > MAX_SCORE) revert ScoreOutOfRange(conformance);
        if (availability > MAX_SCORE) revert ScoreOutOfRange(availability);

        bytes32 node = keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(slug))));

        RESOLVER.setText(node, "conformance", _toString(conformance));
        RESOLVER.setText(node, "availability", _toString(availability));

        emit ScoresPublished(node, slug, conformance, availability);
    }

    /// @dev Hand-rolled rather than importing OpenZeppelin's `Strings`: this is
    ///      the only decimal conversion in the repo and `contracts/` has no
    ///      library beyond forge-std. Bounded by MAX_SCORE, so at most 4 digits.
    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 rest = value; rest != 0; rest /= 10) {
            digits += 1;
        }
        bytes memory buffer = new bytes(digits);
        for (uint256 i = digits; i > 0; i--) {
            buffer[i - 1] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
