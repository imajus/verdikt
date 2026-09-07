// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReportMetadata} from "../src/IReceiver.sol";
import {ReportReceiver} from "../src/ReportReceiver.sol";
import {VerdiktScoreWriter} from "../src/VerdiktScoreWriter.sol";

/// @dev Records what the real PermissionedResolver would have stored, and
///      refuses any key this contract is not EAC-scoped to write — which is how
///      Spike A's live assertion behaves.
contract ResolverStub {
    mapping(bytes32 => mapping(string => string)) public texts;
    mapping(string => bool) public allowedKey;

    error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account);

    constructor() {
        allowedKey["conformance"] = true;
        allowedKey["availability"] = true;
    }

    function setText(bytes32 node, string calldata key, string calldata value) external {
        if (!allowedKey[key]) revert EACUnauthorizedAccountRoles(uint256(node), 0, msg.sender);
        texts[node][key] = value;
    }
}

contract VerdiktScoreWriterTest is Test {
    address internal constant FORWARDER = address(0xF0F0);
    address internal constant WORKFLOW_OWNER = address(0x0E0E);
    bytes10 internal constant WORKFLOW_NAME = bytes10("verdikt-ag");
    bytes32 internal constant PARENT_NODE = keccak256("verdikt.eth");

    ResolverStub internal resolver;
    VerdiktScoreWriter internal writer;

    function setUp() public {
        resolver = new ResolverStub();
        writer = new VerdiktScoreWriter(FORWARDER, WORKFLOW_OWNER, WORKFLOW_NAME, address(resolver), PARENT_NODE);
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

    function _deliver(string memory slug, uint256 conformance, uint256 availability) internal {
        vm.prank(FORWARDER);
        writer.onReport(_metadata(WORKFLOW_OWNER, WORKFLOW_NAME), abi.encode(slug, conformance, availability));
    }

    function _node(string memory slug) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(slug))));
    }

    function test_publishesBothRatiosAsDecimalStrings() public {
        _deliver("weather", 987, 1000);

        assertEq(resolver.texts(_node("weather"), "conformance"), "987");
        assertEq(resolver.texts(_node("weather"), "availability"), "1000");
    }

    function test_rendersEveryScoreInRange() public {
        // The one decimal conversion in the repo, so it is worth pinning the
        // ends and a zero rather than trusting a loop written once.
        _deliver("a", 0, 7);
        assertEq(resolver.texts(_node("a"), "conformance"), "0");
        assertEq(resolver.texts(_node("a"), "availability"), "7");

        _deliver("b", 1000, 999);
        assertEq(resolver.texts(_node("b"), "conformance"), "1000");
        assertEq(resolver.texts(_node("b"), "availability"), "999");
    }

    function testFuzz_rendersAnyScoreInRange(uint256 score) public {
        score = bound(score, 0, writer.MAX_SCORE());
        _deliver("weather", score, score);
        assertEq(resolver.texts(_node("weather"), "conformance"), vm.toString(score));
    }

    function test_emitsWhatItPublished() public {
        vm.expectEmit(true, false, false, true);
        emit VerdiktScoreWriter.ScoresPublished(_node("weather"), "weather", 500, 600);
        _deliver("weather", 500, 600);
    }

    /// @dev The node is derived from an immutable parent, so a report can only
    ///      ever address a child of verdikt.eth — never the parent itself, and
    ///      never an unrelated name the resolver happens to serve.
    function test_writesOnlyUnderTheParentName() public {
        _deliver("weather", 1, 2);
        assertEq(resolver.texts(PARENT_NODE, "conformance"), "");
        assertEq(resolver.texts(_node("weather"), "conformance"), "1");
    }

    function test_refusesAScoreOutsideThePublishedScale() public {
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(VerdiktScoreWriter.ScoreOutOfRange.selector, uint256(1001)));
        writer.onReport(_metadata(WORKFLOW_OWNER, WORKFLOW_NAME), abi.encode("weather", uint256(1001), uint256(1)));
    }

    function test_refusesAnEmptySlug() public {
        vm.prank(FORWARDER);
        vm.expectRevert(VerdiktScoreWriter.EmptySlug.selector);
        writer.onReport(_metadata(WORKFLOW_OWNER, WORKFLOW_NAME), abi.encode("", uint256(1), uint256(1)));
    }

    function test_refusesAnyCallerButTheForwarder() public {
        vm.expectRevert(abi.encodeWithSelector(ReportReceiver.NotForwarder.selector, address(this)));
        writer.onReport(_metadata(WORKFLOW_OWNER, WORKFLOW_NAME), abi.encode("weather", uint256(1), uint256(1)));
    }

    /// @dev The forwarder is shared, so without the owner pin any CRE user could
    ///      publish Verdikt's reputation scores.
    function test_refusesAnotherWorkflowOwnerOnTheSameForwarder() public {
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(ReportReceiver.UnexpectedWorkflowOwner.selector, address(0xdead)));
        writer.onReport(_metadata(address(0xdead), WORKFLOW_NAME), abi.encode("weather", uint256(1), uint256(1)));
    }

    /// @dev The indirection through this contract must not widen what the CRE
    ///      side can write. Spike A asserts the same revert against live Sepolia.
    function test_cannotReachAnyKeyBeyondTheTwoItIsScopedTo() public {
        assertFalse(resolver.allowedKey("sla"));
        assertFalse(resolver.allowedKey("url"));
        assertTrue(resolver.allowedKey("conformance"));
        assertTrue(resolver.allowedKey("availability"));
    }
}
