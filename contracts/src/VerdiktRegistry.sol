// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165, IReceiver, ReportMetadata} from "./IReceiver.sol";
import {IVerdiktRegistry} from "./IVerdiktRegistry.sol";

/// @title VerdiktRegistry
/// @notice Registrar and escrow for Verdikt, on Arc (Specification.md §3).
///
/// @dev Three properties here are correctness rather than style, because a
///      verdict is final and there is no dispute layer:
///
///      1. **A refund never exceeds what the caller paid.** Credit is
///         `min(FIXED_REFUND, paidAmount, remaining deposit)`, never a penalty
///         on top. Anything larger makes deliberately inducing failures
///         profitable, with no arbitration to appeal to.
///      2. **Recording a verdict sends no value.** `onReport` books
///         `owed[payer]` and returns. Pushing value would let a payer address
///         that rejects transfers revert the call and erase its own FAIL — a
///         provider farming its own service through a reverting contract could
///         hold a spotless conformance ratio while failing real calls.
///      3. **A provider cannot walk away from an obligation.** `deregister`
///         reverts while SUSPENDED.
contract VerdiktRegistry is IVerdiktRegistry, IReceiver {
    using ReportMetadata for bytes;

    /// @dev The ABI tuple the CRE workflow encodes into its report. Mirrored in
    ///      `cre/verify/workflow.ts`; the two must change together.
    ///      (bytes32 serviceId, bytes32 requestId, uint8 outcome, address payer, uint256 paidAmount)
    address public immutable FORWARDER;
    address public immutable WORKFLOW_OWNER;
    bytes10 public immutable WORKFLOW_NAME;

    uint256 public immutable DEPOSIT_AMOUNT;
    uint256 public immutable FIXED_REFUND;

    mapping(bytes32 serviceId => Service) private _services;
    mapping(bytes32 requestId => Verdict) private _verdicts;
    mapping(address payer => uint256) private _owed;

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param forwarder the KeystoneForwarder for the target chain. For the
    ///        testnet demo this may be an address Verdikt controls, standing in
    ///        for the forwarder — CRE production enrollment is private beta, so
    ///        attestation is simulated and the submission says so.
    /// @param workflowOwner the CRE account whose workflow may write verdicts.
    ///        Checked in addition to `msg.sender`: the forwarder is shared
    ///        infrastructure, so without this any CRE user could write Verdikt
    ///        verdicts (Spike B, CRE-2).
    /// @param workflowName optional extra pin; pass bytes10(0) to skip.
    constructor(
        address forwarder,
        address workflowOwner,
        bytes10 workflowName,
        uint256 depositAmount,
        uint256 fixedRefund
    ) {
        require(forwarder != address(0), "forwarder=0");
        require(workflowOwner != address(0), "workflowOwner=0");
        require(depositAmount > 0, "deposit=0");
        require(fixedRefund > 0, "refund=0");
        // A per-call refund larger than the whole bond would suspend a service
        // on its first failure, which is a configuration mistake, not a policy.
        require(fixedRefund <= depositAmount, "refund>deposit");
        FORWARDER = forwarder;
        WORKFLOW_OWNER = workflowOwner;
        WORKFLOW_NAME = workflowName;
        DEPOSIT_AMOUNT = depositAmount;
        FIXED_REFUND = fixedRefund;
    }

    // --------------------------------------------------------- provider writes

    /// @inheritdoc IVerdiktRegistry
    function register(string calldata slug) external payable returns (bytes32 serviceId) {
        _assertValidSlug(slug);
        serviceId = keccak256(bytes(slug));

        // Deliberately `!= NONE`, not `== ACTIVE`: a deregistered slug is never
        // reusable. Verdict history is keyed by serviceId, so letting a slug be
        // re-registered would hand a new provider the previous one's record —
        // and the ENS subname and route with it.
        Service storage service = _services[serviceId];
        if (service.status != Status.NONE) revert ServiceAlreadyRegistered(serviceId);
        if (msg.value != DEPOSIT_AMOUNT) revert IncorrectDeposit(DEPOSIT_AMOUNT, msg.value);

        service.provider = msg.sender;
        service.status = Status.ACTIVE;
        service.deposit = msg.value;

        emit ServiceRegistered(serviceId, msg.sender, slug, msg.value);
    }

    /// @inheritdoc IVerdiktRegistry
    function topUp(bytes32 serviceId) external payable {
        Service storage service = _services[serviceId];
        if (service.status == Status.NONE) revert UnknownService(serviceId);
        if (service.status == Status.DEREGISTERED) revert ServiceIsInactive(serviceId, service.status);

        service.deposit += msg.value;
        emit DepositToppedUp(serviceId, msg.value, service.deposit);

        // Reinstatement requires the bond back at full, not merely above zero.
        // Waking a service on dust would leave it ACTIVE while every refund it
        // owes is capped at that dust — the bond would stop meaning anything.
        if (service.status == Status.SUSPENDED && service.deposit >= DEPOSIT_AMOUNT) {
            service.status = Status.ACTIVE;
            emit ServiceReinstated(serviceId, service.deposit);
        }
    }

    /// @inheritdoc IVerdiktRegistry
    function deregister(bytes32 serviceId) external nonReentrant {
        Service storage service = _services[serviceId];
        if (service.status == Status.NONE) revert UnknownService(serviceId);
        if (service.provider != msg.sender) revert NotProvider(serviceId, msg.sender);
        if (service.status == Status.SUSPENDED) revert ServiceIsSuspended(serviceId);
        if (service.status != Status.ACTIVE) revert ServiceIsInactive(serviceId, service.status);

        uint256 returned = service.deposit;
        service.deposit = 0;
        service.status = Status.DEREGISTERED;

        emit ServiceDeregistered(serviceId, msg.sender, returned);
        _send(msg.sender, returned);
    }

    // ----------------------------------------------------------- verdict entry

    /// @inheritdoc IReceiver
    /// @dev The only way a verdict is ever written. Authentication failures
    ///      revert; business declines emit `VerdictRejected` instead, because
    ///      the forwarder does not surface a revert usefully and a silently
    ///      dropped report would be invisible (Spike B, CRE-2).
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != FORWARDER) revert NotForwarder(msg.sender);
        if (metadata.length < ReportMetadata.LENGTH) revert MalformedReportMetadata(metadata.length);

        address owner = metadata.workflowOwner();
        if (owner != WORKFLOW_OWNER) revert UnexpectedWorkflowOwner(owner);
        if (WORKFLOW_NAME != bytes10(0)) {
            bytes10 name = metadata.workflowName();
            if (name != WORKFLOW_NAME) revert UnexpectedWorkflowName(name);
        }

        (bytes32 serviceId, bytes32 requestId, uint8 outcomeOrdinal, address payer, uint256 paidAmount) =
            abi.decode(report, (bytes32, bytes32, uint8, address, uint256));

        if (outcomeOrdinal > uint8(type(Outcome).max)) revert InvalidOutcome(outcomeOrdinal);
        // A zero payer would burn the refund rather than pay anyone. It can only
        // come from a bug in our own workflow, so it is a hard failure.
        if (payer == address(0)) revert ZeroPayer();

        _recordVerdict(serviceId, requestId, Outcome(outcomeOrdinal), payer, paidAmount);
    }

    function _recordVerdict(bytes32 serviceId, bytes32 requestId, Outcome outcome, address payer, uint256 paidAmount)
        private
    {
        if (_verdicts[requestId].writtenAt != 0) {
            emit VerdictRejected(serviceId, requestId, RejectionReason.DUPLICATE_REQUEST);
            return;
        }

        Service storage service = _services[serviceId];
        if (service.status == Status.NONE) {
            emit VerdictRejected(serviceId, requestId, RejectionReason.UNKNOWN_SERVICE);
            return;
        }
        if (service.status == Status.DEREGISTERED) {
            emit VerdictRejected(serviceId, requestId, RejectionReason.SERVICE_DEREGISTERED);
            return;
        }

        uint256 credited;
        if (outcome != Outcome.PASS) {
            credited = FIXED_REFUND;
            if (paidAmount < credited) credited = paidAmount;
            if (service.deposit < credited) credited = service.deposit;
        }

        _verdicts[requestId] = Verdict({
            serviceId: serviceId,
            outcome: outcome,
            payer: payer,
            paidAmount: paidAmount,
            refundCredited: credited,
            writtenAt: uint64(block.timestamp)
        });

        emit VerdictWritten(serviceId, requestId, outcome, payer, paidAmount);

        if (credited > 0) {
            service.deposit -= credited;
            // Booked, never sent. See the contract-level note (2).
            _owed[payer] += credited;
            emit RefundCredited(serviceId, requestId, payer, credited);
        }
        if (service.deposit == 0 && service.status == Status.ACTIVE) {
            service.status = Status.SUSPENDED;
            emit ServiceSuspended(serviceId);
        }
    }

    // ------------------------------------------------------------ payer writes

    /// @inheritdoc IVerdiktRegistry
    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = _owed[msg.sender];
        if (amount == 0) revert NothingOwed(msg.sender);
        // Effects before interaction: a reentrant call finds nothing owed. The
        // guard above is belt-and-braces (Tasks.md 2.2).
        _owed[msg.sender] = 0;
        emit RefundWithdrawn(msg.sender, amount);
        _send(msg.sender, amount);
    }

    // ------------------------------------------------------------------- views

    /// @inheritdoc IVerdiktRegistry
    function serviceIdOf(string calldata slug) external pure returns (bytes32) {
        return keccak256(bytes(slug));
    }

    function getVerdict(bytes32 requestId) external view returns (Verdict memory) {
        return _verdicts[requestId];
    }

    function getService(bytes32 serviceId) external view returns (Service memory) {
        return _services[serviceId];
    }

    function getDeposit(bytes32 serviceId) external view returns (uint256) {
        return _services[serviceId].deposit;
    }

    function getStatus(bytes32 serviceId) external view returns (Status) {
        return _services[serviceId].status;
    }

    function getProvider(bytes32 serviceId) external view returns (address) {
        return _services[serviceId].provider;
    }

    function getOwed(address payer) external view returns (uint256) {
        return _owed[payer];
    }

    /// @inheritdoc IERC165
    /// @dev The forwarder probes this before delivering a report.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ---------------------------------------------------------------- internal

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);
    }

    /// @dev One slug is three identifiers — the Arc serviceId, the
    ///      `<slug>.verdikt.bond` route and the `<slug>.verdikt.eth` subname
    ///      (Specification.md §3). A label that is not valid for DNS and ENS
    ///      would register a service that can never be reached or named, so it
    ///      is refused here rather than discovered at onboarding.
    function _assertValidSlug(string calldata slug) private pure {
        bytes calldata raw = bytes(slug);
        if (raw.length == 0) revert EmptySlug();
        if (raw.length > 63) revert InvalidSlug(slug);
        if (raw[0] == "-" || raw[raw.length - 1] == "-") revert InvalidSlug(slug);
        for (uint256 i = 0; i < raw.length; ++i) {
            bytes1 c = raw[i];
            bool ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-";
            if (!ok) revert InvalidSlug(slug);
        }
    }
}
