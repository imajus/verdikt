// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {VerdiktRegistry} from "../src/VerdiktRegistry.sol";

/// @notice Deploys VerdiktRegistry to Arc Testnet (Tasks.md 2.4).
///
/// @dev Usage:
///
///      forge script script/Deploy.s.sol:Deploy \
///        --rpc-url arc_testnet --broadcast
///
///      Environment:
///        DEPLOYER_PRIVATE_KEY  — funded with native USDC on Arc
///        CRE_FORWARDER_ADDRESS — KeystoneForwarder for the target chain.
///                                Arc Testnet production:
///                                0x76c9cf548b4179F8901cda1f8623568b58215E62
///                                Simulation (`cre workflow simulate --broadcast`):
///                                0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1
///        CRE_WORKFLOW_OWNER    — the CRE account whose workflow may write
///                                verdicts. Required: the forwarder is shared,
///                                so this is the actual access control.
///        CRE_WORKFLOW_NAME     — optional extra pin; empty disables the check.
///        DEPOSIT_AMOUNT        — Arc's 18-decimal NATIVE view (msg.value),
///                                not the 6-decimal ERC-20 view x402 pays in.
///        FIXED_REFUND          — ditto; must be <= DEPOSIT_AMOUNT.
///
///      Record the address in `deployments/arc-testnet.json` and in
///      `VERDIKT_REGISTRY_ADDRESS`.
contract Deploy is Script {
    function run() external returns (VerdiktRegistry registry) {
        address forwarder = vm.envAddress("CRE_FORWARDER_ADDRESS");
        address workflowOwner = vm.envAddress("CRE_WORKFLOW_OWNER");
        bytes10 workflowName = bytes10(bytes(vm.envOr("CRE_WORKFLOW_NAME", string(""))));
        uint256 depositAmount = vm.envOr("DEPOSIT_AMOUNT", uint256(10e18));
        uint256 fixedRefund = vm.envOr("FIXED_REFUND", uint256(1e18));

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        registry = new VerdiktRegistry(forwarder, workflowOwner, workflowName, depositAmount, fixedRefund);
        vm.stopBroadcast();

        console.log("VerdiktRegistry:", address(registry));
        console.log("forwarder:      ", forwarder);
        console.log("workflowOwner:  ", workflowOwner);
        console.log("depositAmount:  ", depositAmount);
        console.log("fixedRefund:    ", fixedRefund);
    }
}
