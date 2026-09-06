// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IVerdiktRegistry
/// @notice Registrar + escrow ABI for Verdikt (Specification.md §3, Tasks.md Phase 2.1).
///         Signatures and events only — Phase 2 supplies the implementation.
///
/// @dev Value moves as `msg.value`, not ERC-20 transfers: USDC is Arc's native
///      gas token, so escrow holds value directly — no `approve`/`transferFrom`
///      and no token address to configure (Specification.md §3). The x402
///      payment, the bond and the refund are therefore the same asset on the
///      same chain, and a refund needs no cross-chain correlation.
///
///      Roles: `verifier` — the CRE workflow's callback signer — is the only
///      address that may write a verdict, and is fixed at construction. Neither
///      a provider nor Verdikt itself holds a verdict-write role, and there is
///      no admin able to grant one (Specification.md §3, "one role per service").
interface IVerdiktRegistry {
    /// @notice Per-call outcome (Specification.md §1).
    /// @dev These ordinals are ABI surface. `packages/sdk/registry.js` mirrors
    ///      them as `OUTCOME_ORDINAL`; the two must change together.
    enum Outcome {
        PASS, // 0
        FAIL_CONFORMANCE, // 1 — a response arrived and broke a clause
        FAIL_UNREACHABLE // 2 — payment settled, nothing usable came back
    }

    enum Status {
        NONE, // 0 — never registered
        ACTIVE, // 1
        SUSPENDED, // 2 — refunds drained the deposit; proxy stops routing here
        DEREGISTERED // 3
    }

    /// @dev `writtenAt == 0` means no verdict is recorded for that requestId.
    struct Verdict {
        bytes32 serviceId;
        Outcome outcome;
        address payer;
        uint256 paidAmount;
        uint256 refundCredited;
        uint64 writtenAt;
    }

    // ------------------------------------------------------------------ events

    /// @dev `slug` is emitted in full because keccak256 is one-way. The
    ///      marketplace reads services straight off RPC logs with no subgraph
    ///      (Specification.md §3, §5), so this event is the only place a
    ///      serviceId can be resolved back to its human-readable slug.
    event ServiceRegistered(
        bytes32 indexed serviceId, address indexed provider, string slug, uint256 deposit
    );

    event DepositToppedUp(bytes32 indexed serviceId, uint256 amount, uint256 balance);

    /// @dev The hourly aggregate workflow (Specification.md §2) replays these
    ///      over a trailing 7-day window to derive the conformance and
    ///      availability ratios, so `serviceId` is indexed and `outcome` is
    ///      carried in the payload.
    event VerdictWritten(
        bytes32 indexed serviceId,
        bytes32 indexed requestId,
        Outcome outcome,
        address payer,
        uint256 paidAmount
    );

    event RefundCredited(
        bytes32 indexed serviceId, bytes32 indexed requestId, address indexed payer, uint256 amount
    );

    event RefundWithdrawn(address indexed payer, uint256 amount);
    event ServiceSuspended(bytes32 indexed serviceId);
    event ServiceDeregistered(
        bytes32 indexed serviceId, address indexed provider, uint256 returnedDeposit
    );

    // ------------------------------------------------------------------ errors

    error EmptySlug();
    error UnknownService(bytes32 serviceId);
    error ServiceAlreadyRegistered(bytes32 serviceId);
    error IncorrectDeposit(uint256 expected, uint256 provided);
    error NotProvider(bytes32 serviceId, address caller);
    error NotVerifier(address caller);
    error ServiceIsSuspended(bytes32 serviceId);
    error ServiceIsInactive(bytes32 serviceId, Status status);
    error DuplicateRequest(bytes32 requestId);
    error NothingOwed(address payer);

    // --------------------------------------------------------- provider writes

    /// @notice Permissionless registration. `msg.value` must equal DEPOSIT_AMOUNT().
    /// @param slug the human-chosen label, reused verbatim as the
    ///        `<slug>.verdikt.bond` routing subdomain and the
    ///        `<slug>.verdikt.eth` ENS subname (Specification.md §3, §4).
    /// @return serviceId keccak256(bytes(slug))
    function register(string calldata slug) external payable returns (bytes32 serviceId);

    function topUp(bytes32 serviceId) external payable;

    /// @notice Provider-only. Delists and returns the remaining deposit.
    /// @dev Reverts while SUSPENDED, so a provider cannot deregister to dodge an
    ///      outstanding refund obligation.
    function deregister(bytes32 serviceId) external;

    // --------------------------------------------------------- verifier writes

    /// @notice Records a per-call verdict and, on either FAIL, credits a refund.
    /// @dev Verifier-only. Credit is `min(FIXED_REFUND(), paidAmount, remaining
    ///      deposit)` — never a penalty on top of the payment, which is what
    ///      keeps induced-failure griefing at break-even-minus-gas with no
    ///      dispute layer to fall back on (Specification.md §3).
    ///
    ///      Books `owed[payer] += amount` and sends nothing: pushing value here
    ///      would let a payer address that rejects transfers revert the whole
    ///      call and erase its own FAIL verdict. `requestId` is recorded so a
    ///      second refund against the same request reverts.
    ///
    ///      `payer` and `paidAmount` are recovered from the x402 payment payload
    ///      by the enclave (Specification.md §2), so no correlation table is
    ///      needed between the payment leg and the refund leg.
    function setVerdict(
        bytes32 serviceId,
        bytes32 requestId,
        Outcome outcome,
        address payer,
        uint256 paidAmount
    ) external;

    // ------------------------------------------------------------ payer writes

    /// @notice Pull payment: the agent collects refunds credited to it.
    function withdraw() external returns (uint256 amount);

    // ------------------------------------------------------------------- views

    /// @dev Canonical slug → serviceId derivation. `packages/sdk` mirrors it in
    ///      JS; Phase 2 tests should assert the two agree.
    function serviceIdOf(string calldata slug) external pure returns (bytes32);

    function getVerdict(bytes32 requestId) external view returns (Verdict memory);
    function getDeposit(bytes32 serviceId) external view returns (uint256);
    function getStatus(bytes32 serviceId) external view returns (Status);
    function getProvider(bytes32 serviceId) external view returns (address);
    function getOwed(address payer) external view returns (uint256);
    function verifier() external view returns (address);

    function DEPOSIT_AMOUNT() external view returns (uint256);
    function FIXED_REFUND() external view returns (uint256);
}
