// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerdiktRegistry} from "./IVerdiktRegistry.sol";
import {ReportReceiver} from "./ReportReceiver.sol";

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
///      4. **A claim's recipient and amount are the payer's alone to name.**
///         `withdrawWithAuthorization` recovers the payer from a signature
///         rather than trusting `msg.sender`, so a payer that cannot itself
///         send an Arc transaction can still be paid, relayed by anyone.
///         Neither field survives being changed after signing, which is what
///         leaves the relayer paying gas and gaining nothing.
contract VerdiktRegistry is IVerdiktRegistry, ReportReceiver {
    /// @notice Bond and refund, in Arc's 18-decimal native view (`msg.value`).
    uint256 public immutable DEPOSIT_AMOUNT;
    uint256 public immutable FIXED_REFUND;

    /// @notice Scale between the two views Arc exposes of the same USDC.
    /// @dev Arc's native token *is* USDC, but `msg.value` and gas use an
    ///      18-decimal view while the ERC-20 view — and therefore x402 payment
    ///      amounts and the SLA's price clause — use 6. They differ by 1e12.
    ///
    ///      This contract is the one place the two meet: `paidAmount` arrives in
    ///      minor units (6) because that is what `decodePayment` normalises to
    ///      and what `VerdictWritten` must carry for the price clause and the
    ///      dashboard, while the bond it is capped against is `msg.value` (18).
    ///      Comparing them unconverted would cap every refund at a millionth of
    ///      a millionth of what the agent actually paid.
    uint256 public constant NATIVE_PER_MINOR_UNIT = 1e12;

    /// @dev Above this, `paidAmount * NATIVE_PER_MINOR_UNIT` would overflow, so
    ///      the conversion saturates instead of reverting. A report that
    ///      absurd is capped by the deposit anyway; reverting would let a
    ///      malformed amount destroy an otherwise valid verdict.
    uint256 private constant MAX_MINOR_UNITS = type(uint256).max / NATIVE_PER_MINOR_UNIT;

    mapping(bytes32 serviceId => Service) private _services;
    mapping(bytes32 requestId => Verdict) private _verdicts;
    mapping(address payer => uint256) private _owed;
    mapping(address payer => mapping(bytes32 nonce => bool used)) private _usedAuthorizations;

    /// @notice EIP-712 domain separator for `withdrawWithAuthorization`.
    /// @dev Fixed at construction from `block.chainid`, not recomputed per
    ///      call — a post-deploy chain fork is out of scope for a testnet
    ///      registry, and recomputing would cost every claim an extra read.
    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev Echoes ERC-3009's `TransferWithAuthorization` — the shape a payer
    ///      already signed once to *pay* — minus `validAfter`, which a claim
    ///      has no use for, and `from`, which is the recovered signer here
    ///      rather than a field.
    bytes32 private constant WITHDRAW_AUTHORIZATION_TYPEHASH =
        keccak256("WithdrawAuthorization(address recipient,uint256 amount,uint256 validBefore,bytes32 nonce)");

    /// @dev A signature with `s` above this is the malleable twin of one below
    ///      it — same signer, same message, different bytes — so rejecting it
    ///      leaves each authorization exactly one valid encoding.
    uint256 private constant SECP256K1_HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

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
    ) ReportReceiver(forwarder, workflowOwner, workflowName) {
        require(depositAmount > 0, "deposit=0");
        require(fixedRefund > 0, "refund=0");
        // A per-call refund larger than the whole bond would suspend a service
        // on its first failure, which is a configuration mistake, not a policy.
        require(fixedRefund <= depositAmount, "refund>deposit");
        DEPOSIT_AMOUNT = depositAmount;
        FIXED_REFUND = fixedRefund;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("VerdiktRegistry")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
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

    /// @notice The only way a verdict is ever written.
    /// @dev  Authentication failures
    ///      revert; business declines emit `VerdictRejected` instead, because
    ///      the forwarder does not surface a revert usefully and a silently
    ///      dropped report would be invisible (Spike B, CRE-2).
    /// @dev The ABI tuple the CRE workflow encodes into its report is mirrored
    ///      in `cre/workflows/verify/workflow.ts`; the two must change together.
    function onReport(bytes calldata metadata, bytes calldata report) external {
        _authenticateReport(metadata);

        (
            bytes32 serviceId,
            bytes32 requestId,
            uint8 outcomeOrdinal,
            address payer,
            uint256 paidAmount,
            bytes32 failedClause
        ) = abi.decode(report, (bytes32, bytes32, uint8, address, uint256, bytes32));

        if (outcomeOrdinal > uint8(type(Outcome).max)) revert InvalidOutcome(outcomeOrdinal);
        // A zero payer would burn the refund rather than pay anyone. It can only
        // come from a bug in our own workflow, so it is a hard failure.
        if (payer == address(0)) revert ZeroPayer();

        _recordVerdict(serviceId, requestId, Outcome(outcomeOrdinal), payer, paidAmount, failedClause);
    }

    function _recordVerdict(
        bytes32 serviceId,
        bytes32 requestId,
        Outcome outcome,
        address payer,
        uint256 paidAmount,
        bytes32 failedClause
    ) private {
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
            // `paidAmount` is in USDC minor units; the bond is in native wei.
            uint256 paidNative = paidAmount > MAX_MINOR_UNITS ? type(uint256).max : paidAmount * NATIVE_PER_MINOR_UNIT;
            credited = FIXED_REFUND;
            if (paidNative < credited) credited = paidNative;
            if (service.deposit < credited) credited = service.deposit;
        }

        // A PASS names no clause. Storing one would be a contradiction a reader
        // would have to reconcile.
        bytes32 clause = outcome == Outcome.PASS ? bytes32(0) : failedClause;

        _verdicts[requestId] = Verdict({
            serviceId: serviceId,
            outcome: outcome,
            payer: payer,
            paidAmount: paidAmount,
            refundCredited: credited,
            writtenAt: uint64(block.timestamp),
            failedClause: clause
        });

        emit VerdictWritten(serviceId, requestId, outcome, payer, paidAmount, clause);

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

    /// @inheritdoc IVerdiktRegistry
    function withdrawWithAuthorization(
        address recipient,
        uint256 amount,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 claimed) {
        if (block.timestamp >= validBefore) revert AuthorizationExpired(validBefore);
        if (recipient == address(0)) revert ZeroRecipient();

        bytes32 structHash =
            keccak256(abi.encode(WITHDRAW_AUTHORIZATION_TYPEHASH, recipient, amount, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address payer = _recoverSigner(digest, v, r, s);

        if (_usedAuthorizations[payer][nonce]) revert AuthorizationAlreadyUsed(payer, nonce);
        uint256 available = _owed[payer];
        if (amount > available) revert InsufficientOwed(payer, amount, available);

        // Effects before interaction, same discipline as `withdraw()`: a
        // reentrant call finds this nonce already spent and nothing left to
        // draw against.
        _usedAuthorizations[payer][nonce] = true;
        _owed[payer] = available - amount;
        claimed = amount;

        emit RefundClaimed(payer, recipient, claimed, nonce);
        _send(recipient, claimed);
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

    /// @inheritdoc IVerdiktRegistry
    function isAuthorizationUsed(address payer, bytes32 nonce) external view returns (bool) {
        return _usedAuthorizations[payer][nonce];
    }

    // ---------------------------------------------------------------- internal

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);
    }

    /// @dev Reverts rather than letting `ecrecover`'s `address(0)` on failure
    ///      fall through as a payer — an account nobody can sign for, and so
    ///      one a bad signature would otherwise quietly draw against.
    function _recoverSigner(bytes32 digest, uint8 v, bytes32 r, bytes32 s) private pure returns (address signer) {
        if (uint256(s) > SECP256K1_HALF_ORDER) revert InvalidSignature();
        if (v != 27 && v != 28) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
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
