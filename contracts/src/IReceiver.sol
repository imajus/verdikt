// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IERC165
/// @dev Declared locally rather than pulled from a dependency: `contracts/`
///      has no library other than forge-std, and this is four lines.
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @title IReceiver
/// @notice The Chainlink KeystoneForwarder's callback interface.
/// @dev A CRE workflow holds no key and sends no transaction. It ABI-encodes a
///      payload, has the DON sign it into a *report*, and the forwarder — after
///      verifying the DON signatures — calls `onReport` here (Spike B, finding
///      CRE-2 in docs/spikes/cre.md). That is why `VerdiktRegistry` has no
///      `setVerdict` an EOA could call.
interface IReceiver is IERC165 {
    /// @param metadata 109-byte header the forwarder prepends, identifying the
    ///        workflow that produced the report. Layout in `ReportMetadata`.
    /// @param report the workflow's own ABI-encoded payload.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title ReportMetadata
/// @notice Reads the KeystoneForwarder's report header.
///
/// @dev The forwarder is shared infrastructure — *any* CRE user on Arc can
///      reach it — so `msg.sender == forwarder` is not access control on its
///      own. Pinning `workflowOwner` is what actually restricts verdict-writing
///      to Verdikt's own workflow (Spike B, CRE-2).
///
///      Layout, 109 bytes total:
///
///      | offset | size | field                 |
///      |--------|------|-----------------------|
///      |      0 |    1 | version               |
///      |      1 |   32 | workflowExecutionId   |
///      |     33 |    4 | timestamp             |
///      |     37 |    4 | donId                 |
///      |     41 |    4 | donConfigVersion      |
///      |     45 |   32 | workflowId            |
///      |     77 |   10 | workflowName          |
///      |     87 |   20 | workflowOwner         |
///      |    107 |    2 | reportId              |
///
///      Taken from the KeystoneForwarder's documented header and cross-checked
///      against the 109-byte total the CRE spike recorded. It has NOT yet been
///      observed against a live forwarder call — a wrong offset here rejects
///      every verdict — so `docs/Tasks.md` §2.4 keeps confirming it as an
///      explicit deploy-time step.
library ReportMetadata {
    uint256 internal constant LENGTH = 109;

    uint256 private constant WORKFLOW_ID_OFFSET = 45;
    uint256 private constant WORKFLOW_NAME_OFFSET = 77;
    uint256 private constant WORKFLOW_OWNER_OFFSET = 87;

    function workflowId(bytes calldata metadata) internal pure returns (bytes32) {
        return bytes32(metadata[WORKFLOW_ID_OFFSET:WORKFLOW_ID_OFFSET + 32]);
    }

    function workflowName(bytes calldata metadata) internal pure returns (bytes10) {
        return bytes10(metadata[WORKFLOW_NAME_OFFSET:WORKFLOW_NAME_OFFSET + 10]);
    }

    function workflowOwner(bytes calldata metadata) internal pure returns (address) {
        return address(bytes20(metadata[WORKFLOW_OWNER_OFFSET:WORKFLOW_OWNER_OFFSET + 20]));
    }
}
