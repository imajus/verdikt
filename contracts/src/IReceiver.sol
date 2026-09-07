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
    /// @param metadata 64-byte header identifying the workflow that produced
    ///        the report. Layout in `ReportMetadata` — and note it is NOT the
    ///        same header the DON signs.
    /// @param report the workflow's own ABI-encoded payload.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title ReportMetadata
/// @notice Reads the header the KeystoneForwarder hands a receiver.
///
/// @dev **There are two different headers, and confusing them costs every
///      verdict.** The DON signs a 109-byte report header — version,
///      executionId, timestamp, donId, donConfigVersion, then the four fields
///      below. The forwarder verifies the signatures against that, strips the
///      first 45 bytes, and passes only the remaining 64 to `onReport`:
///
///      | offset | size | field         |
///      |--------|------|---------------|
///      |      0 |   32 | workflowId    |
///      |     32 |   10 | workflowName  |
///      |     42 |   20 | workflowOwner |
///      |     62 |    2 | reportId      |
///
///      Observed directly, in a `cre workflow simulate --broadcast` delivery on
///      Arc Testnet, traced to `MalformedReportMetadata(64)` against an earlier
///      version of this file that expected 109. The 109-byte layout in the
///      cre-sdk package's `report.js` is real but belongs to the *signed
///      report*, which is why cross-checking against it validated the wrong
///      artefact (docs/spikes/cre.md, CRE-8).
///
///      `workflowName` is raw UTF-8, not a hash. In simulation it is a random
///      per-run string and `workflowOwner` is `0xaAaA...aAaa`, so a receiver
///      that pins production values will reject simulated reports —
///      deliberately.
///
///      The forwarder is shared infrastructure — *any* CRE user can reach it —
///      so `msg.sender == forwarder` is not access control on its own. Pinning
///      `workflowOwner` is what actually restricts writing to Verdikt's own
///      workflow (CRE-2). And the forwarder swallows a receiver revert: it
///      emits its own event with a zero result and the transaction still
///      succeeds, so a rejected report is silent on-chain and has to be found
///      by tracing.
library ReportMetadata {
    uint256 internal constant LENGTH = 64;

    uint256 private constant WORKFLOW_ID_OFFSET = 0;
    uint256 private constant WORKFLOW_NAME_OFFSET = 32;
    uint256 private constant WORKFLOW_OWNER_OFFSET = 42;

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
