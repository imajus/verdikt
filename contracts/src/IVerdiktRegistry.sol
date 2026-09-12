// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IVerdiktRegistry
/// @notice Registrar + escrow ABI for Verdikt (Specification.md §3, Tasks.md Phase 2.1).
///
/// @dev Value moves as `msg.value`, not ERC-20 transfers: USDC is Arc's native
///      gas token, so escrow holds value directly — no `approve`/`transferFrom`
///      and no token address to configure (Specification.md §3). The x402
///      payment, the bond and the refund are therefore the same asset on the
///      same chain, and a refund needs no cross-chain correlation.
///
///      Roles: verdicts arrive only through `IReceiver.onReport`, from the
///      KeystoneForwarder, carrying a report the CRE DON signed on behalf of a
///      pinned `workflowOwner`. There is no `setVerdict` an EOA can call, no
///      verdict-write role a provider could hold, and no admin able to grant
///      one (Specification.md §3, "one role per service"; Spike B, CRE-2).
interface IVerdiktRegistry {
    /// @notice Per-call outcome (Specification.md §1).
    /// @dev These ordinals are ABI surface. `packages/sdk/registry.js` mirrors
    ///      them as `OUTCOME_ORDINAL`; the two must change together.
    enum Outcome {
        PASS, // 0
        FAIL, // 1 — a response arrived and broke a clause
        DOWN // 2 — payment settled, nothing usable came back
    }

    enum Status {
        NONE, // 0 — never registered
        ACTIVE, // 1
        SUSPENDED, // 2 — refunds drained the deposit; proxy stops routing here
        DEREGISTERED // 3
    }

    /// @notice Why a report that authenticated correctly still wrote no verdict.
    /// @dev `onReport` returns nothing and the forwarder does not surface a
    ///      revert usefully (Spike B, CRE-2), so a business-level decline is
    ///      emitted rather than reverted. Reverting would make it invisible.
    enum RejectionReason {
        DUPLICATE_REQUEST, // 0 — a verdict already exists for this requestId
        UNKNOWN_SERVICE, // 1 — never registered
        SERVICE_DEREGISTERED // 2 — delisted; its bond has already gone home
    }

    /// @dev `writtenAt == 0` means no verdict is recorded for that requestId.
    struct Verdict {
        bytes32 serviceId;
        Outcome outcome;
        address payer;
        uint256 paidAmount;
        uint256 refundCredited;
        uint64 writtenAt;
        /// @dev `keccak256(bytes(clauseId))` of the first clause that failed,
        ///      or zero for a PASS. See `VerdictWritten`.
        bytes32 failedClause;
    }

    /// @dev One read for the dashboard's service list (Specification.md §5).
    ///      The slug is not stored — `ServiceRegistered` carries it, and
    ///      keccak256 is one-way, so the event is the only mapping back.
    struct Service {
        address provider;
        Status status;
        uint256 deposit;
    }

    // ------------------------------------------------------------------ events

    /// @dev `slug` is emitted in full because keccak256 is one-way. The
    ///      marketplace reads services straight off RPC logs with no subgraph
    ///      (Specification.md §3, §5), so this event is the only place a
    ///      serviceId can be resolved back to its human-readable slug.
    event ServiceRegistered(bytes32 indexed serviceId, address indexed provider, string slug, uint256 deposit);

    event DepositToppedUp(bytes32 indexed serviceId, uint256 amount, uint256 balance);

    /// @dev The hourly aggregate workflow (Specification.md §2) replays these
    ///      over a trailing 7-day window to derive the conformance and
    ///      availability ratios, so `serviceId` is indexed and `outcome` is
    ///      carried in the payload.
    /// @dev `failedClause` is `keccak256(bytes(clauseId))` of the first clause
    ///      that failed, or zero for a PASS.
    ///
    ///      A hash rather than the string, because the clause id is
    ///      provider-authored and unbounded, and this is written once per paid
    ///      call. Nothing is lost: a reader already holds the SLA from ENS, so
    ///      it hashes the declared ids and matches. An id it cannot match means
    ///      the SLA has been edited since — which is worth showing as exactly
    ///      that rather than papering over.
    ///
    ///      It records WHICH clause broke, never the observed value. The
    ///      `actual` lives in the workflow's return value with the response
    ///      body, and putting it on a public chain would publish a slice of a
    ///      paid response to everyone.
    event VerdictWritten(
        bytes32 indexed serviceId,
        bytes32 indexed requestId,
        Outcome outcome,
        address payer,
        uint256 paidAmount,
        bytes32 failedClause
    );

    /// @dev Emitted instead of reverting, so a declined report is visible
    ///      on-chain rather than swallowed by the forwarder.
    event VerdictRejected(bytes32 indexed serviceId, bytes32 indexed requestId, RejectionReason reason);

    event RefundCredited(bytes32 indexed serviceId, bytes32 indexed requestId, address indexed payer, uint256 amount);

    event RefundWithdrawn(address indexed payer, uint256 amount);

    /// @dev Emitted by `withdrawWithAuthorization`, distinct from
    ///      `RefundWithdrawn` because the recipient is not necessarily the
    ///      payer credited by `RefundCredited` — that is the entire point of
    ///      the signature path (issue #61).
    event RefundClaimed(address indexed payer, address indexed recipient, uint256 amount, bytes32 nonce);

    event ServiceSuspended(bytes32 indexed serviceId);
    event ServiceReinstated(bytes32 indexed serviceId, uint256 deposit);
    event ServiceDeregistered(bytes32 indexed serviceId, address indexed provider, uint256 returnedDeposit);

    // ------------------------------------------------------------------ errors

    error EmptySlug();
    /// @dev The slug is reused verbatim as a DNS label and an ENS label, so one
    ///      that cannot be either is rejected at registration rather than
    ///      producing a service with no reachable route and no subname.
    error InvalidSlug(string slug);
    error UnknownService(bytes32 serviceId);
    error ServiceAlreadyRegistered(bytes32 serviceId);
    error IncorrectDeposit(uint256 expected, uint256 provided);
    error NotProvider(bytes32 serviceId, address caller);
    error ServiceIsSuspended(bytes32 serviceId);
    error ServiceIsInactive(bytes32 serviceId, Status status);
    error NothingOwed(address payer);
    error TransferFailed(address to, uint256 amount);
    error Reentrancy();

    // -- `withdrawWithAuthorization` validity (issue #61).
    error AuthorizationExpired(uint256 validBefore);
    error AuthorizationAlreadyUsed(address payer, bytes32 nonce);
    error InvalidSignature();
    error ZeroRecipient();
    error InsufficientOwed(address payer, uint256 requested, uint256 available);

    // -- report payload validity. The forwarder/workflow-owner checks live in
    // `ReportReceiver`, shared with VerdiktScoreWriter on Sepolia.
    error InvalidOutcome(uint8 ordinal);
    error ZeroPayer();

    // --------------------------------------------------------- provider writes

    /// @notice Permissionless registration. `msg.value` must equal DEPOSIT_AMOUNT().
    /// @param slug the human-chosen label, reused verbatim as the
    ///        `<slug>.verdikt.bond` routing subdomain and the
    ///        `<slug>.verdikt.eth` ENS subname (Specification.md §3, §4).
    /// @return serviceId keccak256(bytes(slug))
    function register(string calldata slug) external payable returns (bytes32 serviceId);

    /// @notice Adds to a service's bond. Reinstates a SUSPENDED service once the
    ///         balance is back at DEPOSIT_AMOUNT().
    function topUp(bytes32 serviceId) external payable;

    /// @notice Provider-only. Delists and returns the remaining deposit.
    /// @dev Reverts while SUSPENDED, so a provider cannot deregister to dodge an
    ///      outstanding refund obligation.
    function deregister(bytes32 serviceId) external;

    // ------------------------------------------------------------ payer writes

    /// @notice Pull payment: the agent collects refunds credited to it.
    function withdraw() external returns (uint256 amount);

    /// @notice Pull payment by signature, relayable by anyone: pays out a
    ///         credit without requiring the credited payer itself to be able
    ///         to send an Arc transaction.
    /// @dev There is no `payer` parameter. The payer is *recovered* from the
    ///      EIP-712 signature over `(recipient, amount, validBefore, nonce)`,
    ///      so the recipient and the amount are the signer's decision alone —
    ///      a relayer supplies the signature verbatim or the call reverts, it
    ///      cannot substitute its own recipient or inflate the amount
    ///      (issue #61). `nonce` is single-use per payer, checked against
    ///      `isAuthorizationUsed`, so the same authorization cannot be
    ///      relayed twice; `validBefore` bounds how long it can be relayed.
    ///      A recipient that rejects the transfer fails only this call — the
    ///      credit itself is untouched, exactly as an EOA's own `withdraw()`
    ///      would leave it.
    /// @param recipient where the payer wants the credit sent. Named by the
    ///        payer at signing time, never by the relayer.
    /// @param amount the exact amount to claim; reverts if it exceeds what is
    ///        currently owed rather than silently capping, so a stale
    ///        authorization fails loudly instead of paying less than signed.
    /// @param validBefore the signature stops verifying at this timestamp.
    /// @param nonce chosen by the signer; opaque to the registry beyond
    ///        single use.
    /// @return claimed the amount actually sent, equal to `amount`.
    function withdrawWithAuthorization(
        address recipient,
        uint256 amount,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 claimed);

    /// @notice Whether `payer` has already spent `nonce` via
    ///         `withdrawWithAuthorization`. Lets a signer or relayer pick a
    ///         fresh nonce, or confirm one has settled, without replaying it.
    function isAuthorizationUsed(address payer, bytes32 nonce) external view returns (bool);

    // ------------------------------------------------------------------- views

    /// @dev Canonical slug → serviceId derivation. `packages/sdk/registry.js`
    ///      mirrors it in JS and both sides assert the same vector.
    function serviceIdOf(string calldata slug) external pure returns (bytes32);

    function getVerdict(bytes32 requestId) external view returns (Verdict memory);
    function getService(bytes32 serviceId) external view returns (Service memory);
    function getDeposit(bytes32 serviceId) external view returns (uint256);
    function getStatus(bytes32 serviceId) external view returns (Status);
    function getProvider(bytes32 serviceId) external view returns (address);
    function getOwed(address payer) external view returns (uint256);

    function DEPOSIT_AMOUNT() external view returns (uint256);
    function FIXED_REFUND() external view returns (uint256);

    /// @notice EIP-712 domain separator `withdrawWithAuthorization` verifies
    ///         against — `name: "VerdiktRegistry"`, `version: "1"`, this
    ///         chain's id, and this contract's own address.
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
