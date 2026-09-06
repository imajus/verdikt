// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165, IReceiver, ReportMetadata} from "./IReceiver.sol";

/// @title ReportReceiver
/// @notice Shared authentication for every contract a Verdikt CRE workflow
///         writes to — `VerdiktRegistry` on Arc and `VerdiktScoreWriter` on
///         Sepolia.
///
/// @dev Factored out rather than copied because it is the whole access control
///      on verdict-writing and on score-publishing, and two copies of that can
///      drift. The property it enforces:
///
///      `msg.sender == forwarder` is **not** sufficient. The KeystoneForwarder
///      is shared infrastructure that any CRE user can reach, so without also
///      pinning the `workflowOwner` carried in the report header, anyone with a
///      CRE account could write Verdikt's verdicts and Verdikt's reputation
///      scores (Spike B, CRE-2).
abstract contract ReportReceiver is IReceiver {
    using ReportMetadata for bytes;

    /// @notice The KeystoneForwarder allowed to deliver reports.
    address public immutable FORWARDER;
    /// @notice The CRE account whose workflow may write here.
    address public immutable WORKFLOW_OWNER;
    /// @notice Optional extra pin on the workflow name; zero disables the check.
    bytes10 public immutable WORKFLOW_NAME;

    error NotForwarder(address caller);
    error MalformedReportMetadata(uint256 length);
    error UnexpectedWorkflowOwner(address owner);
    error UnexpectedWorkflowName(bytes10 name);

    constructor(address forwarder, address workflowOwner, bytes10 workflowName) {
        require(forwarder != address(0), "forwarder=0");
        require(workflowOwner != address(0), "workflowOwner=0");
        FORWARDER = forwarder;
        WORKFLOW_OWNER = workflowOwner;
        WORKFLOW_NAME = workflowName;
    }

    /// @dev Reverts unless this report came from Verdikt's own workflow.
    ///      Authentication failures revert rather than emit: they are bugs or
    ///      attacks, never outcomes.
    function _authenticateReport(bytes calldata metadata) internal view {
        if (msg.sender != FORWARDER) revert NotForwarder(msg.sender);
        if (metadata.length < ReportMetadata.LENGTH) revert MalformedReportMetadata(metadata.length);

        address owner = metadata.workflowOwner();
        if (owner != WORKFLOW_OWNER) revert UnexpectedWorkflowOwner(owner);
        if (WORKFLOW_NAME != bytes10(0)) {
            bytes10 name = metadata.workflowName();
            if (name != WORKFLOW_NAME) revert UnexpectedWorkflowName(name);
        }
    }

    /// @inheritdoc IERC165
    /// @dev The forwarder probes this before delivering a report.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
