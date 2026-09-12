// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC165, IReceiver, ReportMetadata} from "../src/IReceiver.sol";
import {ReportReceiver} from "../src/ReportReceiver.sol";
import {IVerdiktRegistry} from "../src/IVerdiktRegistry.sol";
import {VerdiktRegistry} from "../src/VerdiktRegistry.sol";

/// @dev A payer that refuses value. Its existence is the reason `onReport`
///      books a credit instead of pushing one: a provider could route calls
///      through an address like this and, under a push design, revert away
///      every FAIL its own service earned.
contract RevertingPayer {
    receive() external payable {
        revert("no thanks");
    }
}

contract ReentrantPayer {
    VerdiktRegistry private immutable REGISTRY;
    bool private entered;

    constructor(VerdiktRegistry registry) {
        REGISTRY = registry;
    }

    function collect() external {
        REGISTRY.withdraw();
    }

    receive() external payable {
        if (entered) return;
        entered = true;
        REGISTRY.withdraw();
    }
}

contract VerdiktRegistryTest is Test {
    /// Bond and refund are in Arc's 18-decimal native view (msg.value): 10 and
    /// 1 USDC. `paidAmount` below is in the 6-decimal minor-unit view, which is
    /// what x402 carries — the two differ by 1e12 and the registry converts.
    uint256 internal constant DEPOSIT = 10e18;
    uint256 internal constant REFUND = 1e18;
    uint256 internal constant ONE_USDC_MINOR = 1e6;

    /// @dev `keccak256("latency")` — a stand-in for whatever clause id the SLA declares.
    bytes32 internal constant CLAUSE = keccak256("latency");

    address internal constant FORWARDER = address(0xF0F0);
    address internal constant WORKFLOW_OWNER = address(0x0E0E);
    bytes10 internal constant WORKFLOW_NAME = bytes10("verdikt-v1");

    address internal provider = makeAddr("provider");
    address internal payer;
    uint256 internal payerKey;
    address internal stranger = makeAddr("stranger");

    /// @dev Restated here rather than read off the contract, so these tests
    ///      sign the way an independent off-chain signer would. Taking the
    ///      hash from the contract would make it agree with itself.
    bytes32 internal constant WITHDRAW_AUTHORIZATION_TYPEHASH =
        keccak256("WithdrawAuthorization(address recipient,uint256 amount,uint256 validBefore,bytes32 nonce)");

    VerdiktRegistry internal registry;
    bytes32 internal serviceId;

    string internal constant SLUG = "weather";

    function setUp() public {
        registry = new VerdiktRegistry(FORWARDER, WORKFLOW_OWNER, WORKFLOW_NAME, DEPOSIT, REFUND);
        vm.deal(provider, 100e18);
        serviceId = keccak256(bytes(SLUG));
        (payer, payerKey) = makeAddrAndKey("payer");
    }

    // ------------------------------------------------------------- helpers

    function _register() internal returns (bytes32) {
        vm.prank(provider);
        return registry.register{value: DEPOSIT}(SLUG);
    }

    function _metadata(address owner, bytes10 name) internal pure returns (bytes memory meta) {
        meta = new bytes(ReportMetadata.LENGTH);
        for (uint256 i = 0; i < 10; ++i) {
            meta[32 + i] = name[i];
        }
        bytes20 packed = bytes20(owner);
        for (uint256 i = 0; i < 20; ++i) {
            meta[42 + i] = packed[i];
        }
    }

    function _report(bytes32 id, bytes32 requestId, IVerdiktRegistry.Outcome outcome, address who, uint256 amount)
        internal
        pure
        returns (bytes memory)
    {
        return _report(id, requestId, outcome, who, amount, CLAUSE);
    }

    function _report(
        bytes32 id,
        bytes32 requestId,
        IVerdiktRegistry.Outcome outcome,
        address who,
        uint256 amount,
        bytes32 clause
    ) internal pure returns (bytes memory) {
        return abi.encode(id, requestId, uint8(outcome), who, amount, clause);
    }

    /// @dev Independent of `VerdiktRegistry.DOMAIN_SEPARATOR` — recomputed
    ///      from the same fixed name/version an off-chain signer would use,
    ///      plus `block.chainid` and the deployed address, both readable
    ///      without asking the contract.
    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("VerdiktRegistry")),
                keccak256(bytes("1")),
                block.chainid,
                address(registry)
            )
        );
    }

    function _authorizationDigest(address recipient, uint256 amount, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(WITHDRAW_AUTHORIZATION_TYPEHASH, recipient, amount, validBefore, nonce));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _signAuthorization(
        uint256 signerKey,
        address recipient,
        uint256 amount,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        (v, r, s) = vm.sign(signerKey, _authorizationDigest(recipient, amount, validBefore, nonce));
    }

    function _deliver(bytes32 requestId, IVerdiktRegistry.Outcome outcome, address who, uint256 amount) internal {
        vm.prank(FORWARDER);
        registry.onReport(_metadata(WORKFLOW_OWNER, WORKFLOW_NAME), _report(serviceId, requestId, outcome, who, amount));
    }

    // ----------------------------------------------------------- registration

    function test_registerActivatesAndEmitsTheSlug() public {
        vm.expectEmit(true, true, false, true);
        emit IVerdiktRegistry.ServiceRegistered(serviceId, provider, SLUG, DEPOSIT);
        bytes32 id = _register();

        assertEq(id, serviceId);
        assertEq(uint8(registry.getStatus(id)), uint8(IVerdiktRegistry.Status.ACTIVE));
        assertEq(registry.getDeposit(id), DEPOSIT);
        assertEq(registry.getProvider(id), provider);
    }

    /// @dev The one derivation `packages/sdk/registry.js` mirrors. Both sides
    ///      assert this exact vector; if they ever disagree, a serviceId stops
    ///      resolving and the ENS subname stops matching the route.
    function test_serviceIdOfMatchesTheSharedVector() public view {
        assertEq(registry.serviceIdOf("weather"), 0x00840d14970f593887dc91256f2e2f1380aa176569b6c84f16d7f2ced5965666);
        assertEq(
            registry.serviceIdOf("weather-lite"), 0x899bec1a6fac1010f453e04f5b2827fdd8a3eeeabd5f39a1c54f9539a116a887
        );
    }

    function test_registerRejectsAWrongDeposit() public {
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.IncorrectDeposit.selector, DEPOSIT, DEPOSIT - 1));
        registry.register{value: DEPOSIT - 1}(SLUG);
    }

    function test_registerRejectsADuplicateSlug() public {
        _register();
        vm.deal(stranger, DEPOSIT);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.ServiceAlreadyRegistered.selector, serviceId));
        registry.register{value: DEPOSIT}(SLUG);
    }

    /// @dev Verdict history is keyed by serviceId, so a reusable slug would hand
    ///      a new provider the previous one's record.
    function test_registerRefusesToReuseADeregisteredSlug() public {
        _register();
        vm.prank(provider);
        registry.deregister(serviceId);

        vm.deal(stranger, DEPOSIT);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.ServiceAlreadyRegistered.selector, serviceId));
        registry.register{value: DEPOSIT}(SLUG);
    }

    function test_registerRejectsAnEmptySlug() public {
        vm.prank(provider);
        vm.expectRevert(IVerdiktRegistry.EmptySlug.selector);
        registry.register{value: DEPOSIT}("");
    }

    function test_registerRejectsSlugsThatAreNotValidDnsOrEnsLabels() public {
        string[6] memory bad = ["Weather", "weather.eth", "weather_x", "-weather", "weather-", unicode"wéather"];
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.prank(provider);
            vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.InvalidSlug.selector, bad[i]));
            registry.register{value: DEPOSIT}(bad[i]);
        }
    }

    // ---------------------------------------------------- report authentication

    function test_onReportRejectsAnyCallerButTheForwarder() public {
        _register();
        bytes memory meta = _metadata(WORKFLOW_OWNER, WORKFLOW_NAME);
        bytes memory report = _report(serviceId, "r1", IVerdiktRegistry.Outcome.FAIL, payer, 2500);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ReportReceiver.NotForwarder.selector, stranger));
        registry.onReport(meta, report);

        // Including the provider: no role anywhere lets it grade its own service.
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(ReportReceiver.NotForwarder.selector, provider));
        registry.onReport(meta, report);
    }

    /// @dev The forwarder is shared infrastructure, so `msg.sender` alone is not
    ///      access control — any CRE user could otherwise write Verdikt verdicts.
    function test_onReportRejectsAnotherWorkflowOwnerOnTheSameForwarder() public {
        _register();
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(ReportReceiver.UnexpectedWorkflowOwner.selector, stranger));
        registry.onReport(
            _metadata(stranger, WORKFLOW_NAME), _report(serviceId, "r1", IVerdiktRegistry.Outcome.FAIL, payer, 2500)
        );
    }

    function test_onReportRejectsAnotherWorkflowNameFromTheSameOwner() public {
        _register();
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(ReportReceiver.UnexpectedWorkflowName.selector, bytes10("other-wf")));
        registry.onReport(
            _metadata(WORKFLOW_OWNER, bytes10("other-wf")),
            _report(serviceId, "r1", IVerdiktRegistry.Outcome.FAIL, payer, 2500)
        );
    }

    /// @dev 45 bytes is the length of the prefix the forwarder strips, and was
    ///      briefly what this contract expected to still be there — an earlier
    ///      version read the DON's 109-byte signed-report header instead of the
    ///      64-byte one a receiver is handed, and every delivery reverted
    ///      silently (docs/spikes/cre.md, CRE-8).
    function test_onReportRejectsATruncatedHeader() public {
        _register();
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(ReportReceiver.MalformedReportMetadata.selector, uint256(45)));
        registry.onReport(new bytes(45), _report(serviceId, "r1", IVerdiktRegistry.Outcome.FAIL, payer, 2500));
    }

    /// @dev The exact bytes a KeystoneForwarder delivered on Arc Testnet, taken
    ///      from a traced `cre workflow simulate --broadcast` run. Pinned as a
    ///      literal so a future change to the offsets fails here rather than
    ///      on-chain, where the forwarder swallows the revert.
    function test_acceptsTheHeaderARealForwarderSent() public {
        VerdiktRegistry simulated =
            new VerdiktRegistry(FORWARDER, 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa, bytes10(0), DEPOSIT, REFUND);
        vm.prank(provider);
        simulated.register{value: DEPOSIT}(SLUG);

        bytes memory observed =
            hex"111111111111111111111111111111111111111111111111111111111111111162356236663831393637aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001";
        assertEq(observed.length, 64);

        vm.prank(FORWARDER);
        simulated.onReport(observed, _report(serviceId, "r1", IVerdiktRegistry.Outcome.PASS, payer, 2500));
        assertEq(uint8(simulated.getVerdict("r1").outcome), uint8(IVerdiktRegistry.Outcome.PASS));
    }

    function test_onReportRejectsAnOutcomeOrdinalOutsideTheEnum() public {
        _register();
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.InvalidOutcome.selector, uint8(3)));
        registry.onReport(
            _metadata(WORKFLOW_OWNER, WORKFLOW_NAME),
            abi.encode(serviceId, bytes32("r1"), uint8(3), payer, uint256(1), CLAUSE)
        );
    }

    function test_onReportRejectsAZeroPayer() public {
        _register();
        vm.prank(FORWARDER);
        vm.expectRevert(IVerdiktRegistry.ZeroPayer.selector);
        registry.onReport(
            _metadata(WORKFLOW_OWNER, WORKFLOW_NAME),
            _report(serviceId, "r1", IVerdiktRegistry.Outcome.FAIL, address(0), 2500)
        );
    }

    function test_workflowNameCheckIsSkippedWhenUnpinned() public {
        VerdiktRegistry unpinned = new VerdiktRegistry(FORWARDER, WORKFLOW_OWNER, bytes10(0), DEPOSIT, REFUND);
        vm.deal(provider, DEPOSIT);
        vm.prank(provider);
        unpinned.register{value: DEPOSIT}(SLUG);

        vm.prank(FORWARDER);
        unpinned.onReport(
            _metadata(WORKFLOW_OWNER, bytes10("anything!!")),
            _report(serviceId, "r1", IVerdiktRegistry.Outcome.FAIL, payer, 2500)
        );
        assertEq(unpinned.getOwed(payer), 2500 * registry.NATIVE_PER_MINOR_UNIT());
    }

    function test_supportsTheForwardersProbe() public view {
        assertTrue(registry.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(registry.supportsInterface(type(IERC165).interfaceId));
        assertFalse(registry.supportsInterface(bytes4(0xdeadbeef)));
    }

    // --------------------------------------------------------- failure detail

    function test_failRecordsWhichClauseBroke() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 2500);

        assertEq(registry.getVerdict("r1").failedClause, CLAUSE);
    }

    /// @dev A PASS naming a clause is a contradiction, and the chain is where a
    ///      reader has no way to ask which half was meant. The registry drops
    ///      the clause rather than storing one nothing can reconcile.
    function test_passStoresNoClauseEvenIfTheReportNamesOne() public {
        _register();
        vm.prank(FORWARDER);
        registry.onReport(
            _metadata(WORKFLOW_OWNER, WORKFLOW_NAME),
            _report(serviceId, "r1", IVerdiktRegistry.Outcome.PASS, payer, 2500, CLAUSE)
        );

        assertEq(registry.getVerdict("r1").failedClause, bytes32(0));
    }

    /// @dev The clause id is provider-authored, so the registry cannot check it
    ///      against anything. An unnamed failure still has to record the failure.
    function test_failWithoutAClauseStillCreditsTheRefund() public {
        _register();
        vm.prank(FORWARDER);
        registry.onReport(
            _metadata(WORKFLOW_OWNER, WORKFLOW_NAME),
            _report(serviceId, "r1", IVerdiktRegistry.Outcome.FAIL, payer, 5 * ONE_USDC_MINOR, bytes32(0))
        );

        assertEq(registry.getVerdict("r1").failedClause, bytes32(0));
        assertEq(registry.getOwed(payer), REFUND);
    }

    // ------------------------------------------------------------- accounting

    function test_passCreditsNothingAndLeavesTheDepositAlone() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.PASS, payer, 2500);

        assertEq(registry.getDeposit(serviceId), DEPOSIT);
        assertEq(registry.getOwed(payer), 0);
        assertEq(registry.getVerdict("r1").refundCredited, 0);
        assertEq(uint8(registry.getVerdict("r1").outcome), uint8(IVerdiktRegistry.Outcome.PASS));
    }

    function test_failCreditsARefundFromTheDeposit() public {
        _register();
        vm.expectEmit(true, true, true, true);
        emit IVerdiktRegistry.RefundCredited(serviceId, "r1", payer, REFUND);
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);

        assertEq(registry.getDeposit(serviceId), DEPOSIT - REFUND);
        assertEq(registry.getOwed(payer), REFUND);
    }

    /// @dev A DOWN refunds for the same reason a FAIL does: that one call took
    ///      payment and delivered nothing. It is not the availability score.
    function test_downRefundsLikeAFail() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.DOWN, payer, 5e6);
        assertEq(registry.getOwed(payer), REFUND);
        assertEq(registry.getDeposit(serviceId), DEPOSIT - REFUND);
    }

    /// @dev The cap that keeps induced-failure griefing at break-even-minus-gas.
    ///      400 minor units is $0.0004, well under the 1 USDC fixed refund.
    function test_refundNeverExceedsWhatWasPaid() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 400);
        assertEq(registry.getOwed(payer), 400 * registry.NATIVE_PER_MINOR_UNIT());
        assertEq(registry.getDeposit(serviceId), DEPOSIT - 400 * registry.NATIVE_PER_MINOR_UNIT());
    }

    /// @dev Arc exposes the same USDC as 18 decimals natively and 6 as an
    ///      ERC-20. x402 pays in the 6-decimal view and the bond is held in the
    ///      18-decimal one, so an unconverted comparison would have refunded a
    ///      millionth of a millionth of what the agent paid.
    function test_refundConvertsMinorUnitsToTheNativeView() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, ONE_USDC_MINOR / 2);
        assertEq(registry.getOwed(payer), 0.5e18);

        // And the event still carries the amount in minor units, which is what
        // the price clause and the dashboard read.
        assertEq(registry.getVerdict("r1").paidAmount, ONE_USDC_MINOR / 2);
    }

    /// @dev A nonsense amount must not be able to revert an otherwise valid
    ///      verdict by overflowing the conversion.
    function test_anAbsurdPaidAmountSaturatesInsteadOfReverting() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, type(uint256).max);
        assertEq(registry.getOwed(payer), REFUND);
    }

    function testFuzz_refundIsCappedThreeWays(uint96 paidAmount, uint8 outcomeOrdinal) public {
        outcomeOrdinal = uint8(bound(outcomeOrdinal, 0, 2));
        _register();
        uint256 before = registry.getDeposit(serviceId);
        _deliver("r1", IVerdiktRegistry.Outcome(outcomeOrdinal), payer, paidAmount);

        uint256 credited = registry.getVerdict("r1").refundCredited;
        assertLe(credited, uint256(paidAmount) * registry.NATIVE_PER_MINOR_UNIT());
        assertLe(credited, REFUND);
        assertLe(credited, before);
        if (outcomeOrdinal == uint8(IVerdiktRegistry.Outcome.PASS)) assertEq(credited, 0);
        assertEq(registry.getDeposit(serviceId), before - credited);
        assertEq(registry.getOwed(payer), credited);
    }

    function test_creditLargerThanTheRemainingDepositBooksTheRemainderAndSuspends() public {
        VerdiktRegistry chunky = new VerdiktRegistry(FORWARDER, WORKFLOW_OWNER, WORKFLOW_NAME, DEPOSIT, 3e18);
        vm.prank(provider);
        chunky.register{value: DEPOSIT}(SLUG);

        for (uint256 i = 0; i < 3; ++i) {
            vm.prank(FORWARDER);
            chunky.onReport(
                _metadata(WORKFLOW_OWNER, WORKFLOW_NAME),
                _report(serviceId, bytes32(i + 1), IVerdiktRegistry.Outcome.FAIL, payer, 10e6)
            );
        }
        assertEq(chunky.getDeposit(serviceId), 1e18);

        vm.expectEmit(true, false, false, false);
        emit IVerdiktRegistry.ServiceSuspended(serviceId);
        vm.prank(FORWARDER);
        chunky.onReport(
            _metadata(WORKFLOW_OWNER, WORKFLOW_NAME),
            _report(serviceId, bytes32(uint256(4)), IVerdiktRegistry.Outcome.FAIL, payer, 10e6)
        );

        assertEq(chunky.getDeposit(serviceId), 0);
        assertEq(chunky.getOwed(payer), 10e18);
        assertEq(uint8(chunky.getStatus(serviceId)), uint8(IVerdiktRegistry.Status.SUSPENDED));
    }

    function test_draining_theDepositSuspendsTheService() public {
        _register();
        for (uint256 i = 0; i < 10; ++i) {
            _deliver(bytes32(i + 1), IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        }
        assertEq(registry.getDeposit(serviceId), 0);
        assertEq(uint8(registry.getStatus(serviceId)), uint8(IVerdiktRegistry.Status.SUSPENDED));
        assertEq(registry.getOwed(payer), 10e18);
    }

    // -------------------------------------------------------- declined reports

    function test_aSecondReportOnTheSameRequestIsRejectedNotPaidTwice() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);

        vm.expectEmit(true, true, false, true);
        emit IVerdiktRegistry.VerdictRejected(serviceId, "r1", IVerdiktRegistry.RejectionReason.DUPLICATE_REQUEST);
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);

        assertEq(registry.getOwed(payer), REFUND);
        assertEq(registry.getDeposit(serviceId), DEPOSIT - REFUND);
    }

    function test_aReportForAnUnknownServiceIsRejected() public {
        vm.expectEmit(true, true, false, true);
        emit IVerdiktRegistry.VerdictRejected(serviceId, "r1", IVerdiktRegistry.RejectionReason.UNKNOWN_SERVICE);
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        assertEq(registry.getOwed(payer), 0);
        assertEq(registry.getVerdict("r1").writtenAt, 0);
    }

    function test_aReportForADeregisteredServiceIsRejected() public {
        _register();
        vm.prank(provider);
        registry.deregister(serviceId);

        vm.expectEmit(true, true, false, true);
        emit IVerdiktRegistry.VerdictRejected(serviceId, "r1", IVerdiktRegistry.RejectionReason.SERVICE_DEREGISTERED);
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        assertEq(registry.getOwed(payer), 0);
    }

    /// @dev A verdict must be recordable even when the payer refuses money.
    function test_aPayerThatRejectsTransfersStillGetsItsFailRecorded() public {
        _register();
        address hostile = address(new RevertingPayer());

        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, hostile, 5e6);

        assertEq(uint8(registry.getVerdict("r1").outcome), uint8(IVerdiktRegistry.Outcome.FAIL));
        assertEq(registry.getOwed(hostile), REFUND);
        assertEq(registry.getDeposit(serviceId), DEPOSIT - REFUND);

        // It simply cannot collect — which is its own problem, not the record's.
        vm.prank(hostile);
        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.TransferFailed.selector, hostile, REFUND));
        registry.withdraw();
    }

    // -------------------------------------------------- suspension and exit

    function test_deregisterIsBlockedWhileSuspended() public {
        _register();
        for (uint256 i = 0; i < 10; ++i) {
            _deliver(bytes32(i + 1), IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        }
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.ServiceIsSuspended.selector, serviceId));
        registry.deregister(serviceId);
    }

    function test_deregisterIsProviderOnly() public {
        _register();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.NotProvider.selector, serviceId, stranger));
        registry.deregister(serviceId);
    }

    function test_deregisterReturnsTheRemainingDeposit() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);

        uint256 before = provider.balance;
        vm.prank(provider);
        registry.deregister(serviceId);

        assertEq(provider.balance - before, DEPOSIT - REFUND);
        assertEq(uint8(registry.getStatus(serviceId)), uint8(IVerdiktRegistry.Status.DEREGISTERED));
    }

    function test_topUpBackToFullReinstatesTheService() public {
        _register();
        for (uint256 i = 0; i < 10; ++i) {
            _deliver(bytes32(i + 1), IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        }

        // Dust must not wake it: every refund it then owed would be capped at dust.
        vm.prank(provider);
        registry.topUp{value: 1}(serviceId);
        assertEq(uint8(registry.getStatus(serviceId)), uint8(IVerdiktRegistry.Status.SUSPENDED));

        vm.expectEmit(true, false, false, true);
        emit IVerdiktRegistry.ServiceReinstated(serviceId, DEPOSIT);
        vm.prank(provider);
        registry.topUp{value: DEPOSIT - 1}(serviceId);
        assertEq(uint8(registry.getStatus(serviceId)), uint8(IVerdiktRegistry.Status.ACTIVE));
    }

    function test_topUpRejectsAnUnknownOrDeregisteredService() public {
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.UnknownService.selector, serviceId));
        registry.topUp{value: 1e18}(serviceId);

        _register();
        vm.prank(provider);
        registry.deregister(serviceId);
        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVerdiktRegistry.ServiceIsInactive.selector, serviceId, IVerdiktRegistry.Status.DEREGISTERED
            )
        );
        registry.topUp{value: 1e18}(serviceId);
    }

    // ---------------------------------------------------------------- withdraw

    function test_withdrawPaysTheCreditedRefundOnce() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);

        uint256 before = payer.balance;
        vm.prank(payer);
        uint256 amount = registry.withdraw();

        assertEq(amount, REFUND);
        assertEq(payer.balance - before, REFUND);
        assertEq(registry.getOwed(payer), 0);
    }

    function test_withdrawWithNothingOwedReverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.NothingOwed.selector, stranger));
        registry.withdraw();
    }

    function test_reentrantWithdrawCannotDoublePay() public {
        _register();
        ReentrantPayer attacker = new ReentrantPayer(registry);
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, address(attacker), 5e6);

        // The guard trips inside the re-entry, which bubbles out through the
        // value transfer and fails the whole withdrawal — nothing is paid twice.
        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.TransferFailed.selector, address(attacker), REFUND));
        attacker.collect();

        assertEq(address(attacker).balance, 0);
        assertEq(registry.getOwed(address(attacker)), REFUND);
    }

    // ------------------------------------------------ withdrawWithAuthorization

    /// @dev The whole point: a relayer with no key of the payer's own can
    ///      still move the credit, to whatever address the payer named.
    function test_withdrawWithAuthorizationPaysTheRecipientTheSignerNamed() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        address recipient = makeAddr("recipient");
        address relayer = makeAddr("relayer");
        bytes32 nonce = keccak256("n1");
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(payerKey, recipient, REFUND, validBefore, nonce);

        vm.expectEmit(true, true, false, true);
        emit IVerdiktRegistry.RefundClaimed(payer, recipient, REFUND, nonce);
        vm.prank(relayer);
        uint256 claimed = registry.withdrawWithAuthorization(recipient, REFUND, validBefore, nonce, v, r, s);

        assertEq(claimed, REFUND);
        assertEq(recipient.balance, REFUND);
        assertEq(relayer.balance, 0);
        assertEq(registry.getOwed(payer), 0);
        assertTrue(registry.isAuthorizationUsed(payer, nonce));
    }

    /// @dev Nothing about relaying requires the relayer to be anyone in
    ///      particular — not the payer, not the recipient.
    function test_withdrawWithAuthorizationCanBeRelayedByAThirdParty() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        (uint8 v, bytes32 r, bytes32 s) =
            _signAuthorization(payerKey, payer, REFUND, block.timestamp + 1 hours, keccak256("n1"));

        vm.prank(stranger);
        registry.withdrawWithAuthorization(payer, REFUND, block.timestamp + 1 hours, keccak256("n1"), v, r, s);

        assertEq(payer.balance, REFUND);
    }

    function test_withdrawWithAuthorizationCanClaimLessThanFullyOwedLeavingTheRemainder() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        _deliver("r2", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        assertEq(registry.getOwed(payer), 2 * REFUND);

        address recipient = makeAddr("recipient");
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(payerKey, recipient, REFUND, validBefore, keccak256("n1"));
        registry.withdrawWithAuthorization(recipient, REFUND, validBefore, keccak256("n1"), v, r, s);

        assertEq(recipient.balance, REFUND);
        assertEq(registry.getOwed(payer), REFUND);

        // The remainder is still claimable, under a fresh nonce.
        (v, r, s) = _signAuthorization(payerKey, recipient, REFUND, validBefore, keccak256("n2"));
        registry.withdrawWithAuthorization(recipient, REFUND, validBefore, keccak256("n2"), v, r, s);
        assertEq(recipient.balance, 2 * REFUND);
        assertEq(registry.getOwed(payer), 0);
    }

    function test_withdrawWithAuthorizationRejectsAReplayedNonce() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        _deliver("r2", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("n1");
        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(payerKey, payer, REFUND, validBefore, nonce);
        registry.withdrawWithAuthorization(payer, REFUND, validBefore, nonce, v, r, s);

        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.AuthorizationAlreadyUsed.selector, payer, nonce));
        registry.withdrawWithAuthorization(payer, REFUND, validBefore, nonce, v, r, s);

        // The first claim went through; only the replay was refused.
        assertEq(registry.getOwed(payer), REFUND);
    }

    function test_withdrawWithAuthorizationRejectsAnExpiredAuthorization() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        uint256 validBefore = block.timestamp;
        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(payerKey, payer, REFUND, validBefore, keccak256("n1"));

        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.AuthorizationExpired.selector, validBefore));
        registry.withdrawWithAuthorization(payer, REFUND, validBefore, keccak256("n1"), v, r, s);
    }

    function test_withdrawWithAuthorizationRejectsAZeroRecipient() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(payerKey, address(0), REFUND, validBefore, keccak256("n1"));

        vm.expectRevert(IVerdiktRegistry.ZeroRecipient.selector);
        registry.withdrawWithAuthorization(address(0), REFUND, validBefore, keccak256("n1"), v, r, s);
    }

    function test_withdrawWithAuthorizationRejectsAnAmountAboveWhatsOwed() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        uint256 validBefore = block.timestamp + 1 hours;
        uint256 tooMuch = REFUND + 1;
        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(payerKey, payer, tooMuch, validBefore, keccak256("n1"));

        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.InsufficientOwed.selector, payer, tooMuch, REFUND));
        registry.withdrawWithAuthorization(payer, tooMuch, validBefore, keccak256("n1"), v, r, s);
    }

    /// @dev Nothing is owed to a stranger who never had a verdict credited —
    ///      the same authentication path a live, unbonded service exercises.
    function test_withdrawWithAuthorizationWithNothingOwedReverts() public {
        (address signer, uint256 signerKey) = makeAddrAndKey("uncredited");
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(signerKey, signer, 1, validBefore, keccak256("n1"));

        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.InsufficientOwed.selector, signer, 1, 0));
        registry.withdrawWithAuthorization(signer, 1, validBefore, keccak256("n1"), v, r, s);
    }

    /// @dev Changing any signed field after signing recovers a different
    ///      address entirely — there is no `payer` parameter to mismatch
    ///      against, so tampering just points the claim at an account that
    ///      (almost certainly) owns no credit rather than at a recognisable
    ///      "wrong signer" error.
    function test_withdrawWithAuthorizationRejectsATamperedRecipient() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("n1");
        address signedRecipient = makeAddr("recipient");
        address swappedRecipient = makeAddr("attacker-recipient");
        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(payerKey, signedRecipient, REFUND, validBefore, nonce);

        vm.expectPartialRevert(IVerdiktRegistry.InsufficientOwed.selector);
        registry.withdrawWithAuthorization(swappedRecipient, REFUND, validBefore, nonce, v, r, s);
    }

    function test_withdrawWithAuthorizationRejectsAnOutOfRangeVValue() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        uint256 validBefore = block.timestamp + 1 hours;
        (, bytes32 r, bytes32 s) = _signAuthorization(payerKey, payer, REFUND, validBefore, keccak256("n1"));

        vm.expectRevert(IVerdiktRegistry.InvalidSignature.selector);
        registry.withdrawWithAuthorization(payer, REFUND, validBefore, keccak256("n1"), 17, r, s);
    }

    /// @dev The malleable twin of a valid signature — same signer, same
    ///      message, `s` flipped to the curve's upper half and `v` flipped to
    ///      match — must not verify. Otherwise every authorization would have
    ///      two valid encodings instead of one.
    function test_withdrawWithAuthorizationRejectsAMalleableSignature() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("n1");
        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(payerKey, payer, REFUND, validBefore, nonce);

        // secp256k1's order n; the flipped signature over the same digest is
        // (r, n - s, 27 ^ 28 ^ v).
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 flippedS = bytes32(n - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        vm.expectRevert(IVerdiktRegistry.InvalidSignature.selector);
        registry.withdrawWithAuthorization(payer, REFUND, validBefore, nonce, flippedV, r, flippedS);
    }

    /// @dev A recipient that rejects the transfer loses only this claim — the
    ///      nonce is not spent and the credit is not decremented, so the payer
    ///      can sign a fresh authorization naming an address that can collect.
    function test_withdrawWithAuthorizationRecipientThatRejectsValueFailsOnlyItsOwnClaim() public {
        _register();
        address hostile = address(new RevertingPayer());
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("n1");
        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(payerKey, hostile, REFUND, validBefore, nonce);

        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.TransferFailed.selector, hostile, REFUND));
        registry.withdrawWithAuthorization(hostile, REFUND, validBefore, nonce, v, r, s);

        assertEq(registry.getOwed(payer), REFUND);
        assertFalse(registry.isAuthorizationUsed(payer, nonce));
    }

    /// @dev Same shared `_lock` as `withdraw()`: a recipient that re-enters
    ///      during its own payout cannot double-spend the credit.
    ///
    ///      The attacker is credited a refund of its own first, deliberately.
    ///      Without that, its re-entrant `withdraw()` would revert
    ///      `NothingOwed` and the test would pass with the guard deleted —
    ///      proving nothing about the lock. Owed something, the re-entry is a
    ///      real second payout that only `nonReentrant` stops.
    function test_reentrantRecipientCannotDoublePayViaWithdrawWithAuthorization() public {
        _register();
        ReentrantPayer attacker = new ReentrantPayer(registry);
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        _deliver("r2", IVerdiktRegistry.Outcome.FAIL, address(attacker), 5e6);
        assertEq(registry.getOwed(address(attacker)), REFUND);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("n1");
        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(payerKey, address(attacker), REFUND, validBefore, nonce);

        vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.TransferFailed.selector, address(attacker), REFUND));
        registry.withdrawWithAuthorization(address(attacker), REFUND, validBefore, nonce, v, r, s);

        assertEq(address(attacker).balance, 0);
        assertEq(registry.getOwed(payer), REFUND);
        assertEq(registry.getOwed(address(attacker)), REFUND);
        assertFalse(registry.isAuthorizationUsed(payer, nonce));
    }

    /// @dev The digest is bound to this deployment through
    ///      `DOMAIN_SEPARATOR`'s `verifyingContract`. A signature made against
    ///      a sibling registry recovers some unrelated address here rather
    ///      than the payer, so a credit cannot be drawn across deployments —
    ///      the same binding that stops a cross-chain replay, and the one a
    ///      refactor of the separator would silently drop.
    function test_withdrawWithAuthorizationIsBoundToThisDeployment() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        VerdiktRegistry sibling = new VerdiktRegistry(FORWARDER, WORKFLOW_OWNER, WORKFLOW_NAME, DEPOSIT, REFUND);
        assertTrue(sibling.DOMAIN_SEPARATOR() != registry.DOMAIN_SEPARATOR());

        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("n1");
        bytes32 structHash = keccak256(abi.encode(WITHDRAW_AUTHORIZATION_TYPEHASH, payer, REFUND, validBefore, nonce));
        bytes32 foreignDigest = keccak256(abi.encodePacked("\x19\x01", sibling.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, foreignDigest);

        vm.expectPartialRevert(IVerdiktRegistry.InsufficientOwed.selector);
        registry.withdrawWithAuthorization(payer, REFUND, validBefore, nonce, v, r, s);
        assertEq(registry.getOwed(payer), REFUND);
    }

    /// @dev A claim of nothing would otherwise succeed for *any* signature —
    ///      zero never exceeds what an address is owed, so a forged one would
    ///      spend a nonce and emit `RefundClaimed` for an account nobody signed
    ///      as. `withdraw()` refuses to pay nothing; so does this.
    function test_withdrawWithAuthorizationRejectsAZeroClaim() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("n1");
        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(payerKey, payer, 0, validBefore, nonce);

        vm.expectRevert(IVerdiktRegistry.ZeroClaim.selector);
        registry.withdrawWithAuthorization(payer, 0, validBefore, nonce, v, r, s);
        assertFalse(registry.isAuthorizationUsed(payer, nonce));
    }

    /// @dev The same zero claim, this time with bytes nobody signed. It must
    ///      not be the one shape an unauthenticated caller can push through.
    function test_withdrawWithAuthorizationRejectsAZeroClaimOnAForgedSignature() public {
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 s = bytes32(uint256(1));
        bytes32 r;
        for (uint256 i = 0; i < 64; ++i) {
            r = keccak256(abi.encode(i));
            if (ecrecover(bytes32(uint256(1)), 27, r, s) != address(0)) break;
        }

        vm.expectRevert(IVerdiktRegistry.ZeroClaim.selector);
        registry.withdrawWithAuthorization(stranger, 0, validBefore, keccak256("junk"), 27, r, s);
    }

    function testFuzz_withdrawWithAuthorizationNeverPaysMoreThanSigned(uint64 paidMinor, uint256 requested) public {
        _register();
        // A non-zero payment always credits something: `min` of three terms
        // that are each non-zero here. So `owed > 0` needs no second assume.
        vm.assume(paidMinor > 0);
        vm.assume(requested > 0);
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, paidMinor);
        uint256 owed = registry.getOwed(payer);

        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("n1");
        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(payerKey, payer, requested, validBefore, nonce);

        if (requested > owed) {
            vm.expectRevert(abi.encodeWithSelector(IVerdiktRegistry.InsufficientOwed.selector, payer, requested, owed));
            registry.withdrawWithAuthorization(payer, requested, validBefore, nonce, v, r, s);
        } else {
            uint256 claimed = registry.withdrawWithAuthorization(payer, requested, validBefore, nonce, v, r, s);
            assertEq(claimed, requested);
            assertEq(payer.balance, requested);
            assertEq(registry.getOwed(payer), owed - requested);
        }
    }

    // --------------------------------------------------------------- solvency

    /// @dev Every wei the contract holds is either a service's bond or a payer's
    ///      credit. A refund moves value between those two buckets and never
    ///      creates any.
    function test_balanceAlwaysEqualsBondsPlusCredits() public {
        _register();
        _deliver("r1", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        _deliver("r2", IVerdiktRegistry.Outcome.PASS, payer, 5e6);
        _deliver("r3", IVerdiktRegistry.Outcome.DOWN, stranger, 300);

        assertEq(
            address(registry).balance,
            registry.getDeposit(serviceId) + registry.getOwed(payer) + registry.getOwed(stranger)
        );

        vm.prank(payer);
        registry.withdraw();
        assertEq(address(registry).balance, registry.getDeposit(serviceId) + registry.getOwed(stranger));

        // The signature path moves value out of the same two buckets, so it
        // has to leave the identity standing too.
        _deliver("r4", IVerdiktRegistry.Outcome.FAIL, payer, 5e6);
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            _signAuthorization(payerKey, makeAddr("elsewhere"), REFUND, validBefore, keccak256("n1"));
        vm.prank(stranger);
        registry.withdrawWithAuthorization(makeAddr("elsewhere"), REFUND, validBefore, keccak256("n1"), v, r, s);

        assertEq(
            address(registry).balance,
            registry.getDeposit(serviceId) + registry.getOwed(payer) + registry.getOwed(stranger)
        );
    }
}
