// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {EnsNamehash} from "../src/EnsNamehash.sol";
import {VerdiktScoreWriter} from "../src/VerdiktScoreWriter.sol";

/// @notice Deploys VerdiktScoreWriter to Ethereum Sepolia (Tasks.md 3.2).
///
/// @dev This is the contract that exists because a CRE workflow cannot call an
///      ENS resolver: its only on-chain write is a DON-signed report to an
///      `IReceiver`, and a resolver is not one (Spike B, CRE-2).
///
///      Usage:
///
///      forge script script/DeployScoreWriter.s.sol:DeployScoreWriter \
///        --rpc-url sepolia --broadcast
///
///      Environment:
///        DEPLOYER_PRIVATE_KEY   — funded with Sepolia ETH
///        CRE_SEPOLIA_FORWARDER  — KeystoneForwarder on Sepolia,
///                                 0xF8344CFd5c43616a4366C34E3EEE75af79a74482
///        CRE_WORKFLOW_OWNER     — the CRE account whose workflow may publish
///                                 scores. Required: the forwarder is shared, so
///                                 without this any CRE user could publish
///                                 Verdikt's reputation numbers.
///        CRE_WORKFLOW_NAME      — optional extra pin; empty disables the check.
///        ENS_RESOLVER_ADDRESS   — the PermissionedResolver serving
///                                 <slug>.verdikt.eth.
///        ENS_PARENT_NAME        — e.g. "verdikt.eth". The node is derived from
///                                 it here (EnsNamehash), not configured
///                                 separately: a second setting holding a value
///                                 wholly derived from this one could only ever
///                                 disagree with it, and the failure would be a
///                                 score writer publishing to a name nobody
///                                 resolves.
///
///      **Deployment is not finished when this returns.** The contract can only
///      write once the resolver has granted it the two keys:
///
///        authorizeTextRoles(dnsEncode("<slug>.verdikt.eth"), "conformance", scoreWriter, true)
///        authorizeTextRoles(dnsEncode("<slug>.verdikt.eth"), "availability", scoreWriter, true)
///
///      per subname, from the operator. Grant per key with `authorizeTextRoles`,
///      never name-wide with `authorizeNameRoles` — Spike A found that the
///      name-wide grant is one of the two routes that bypasses the per-key ACL
///      the whole ENSv2 choice rests on.
contract DeployScoreWriter is Script {
    function run() external returns (VerdiktScoreWriter writer) {
        address forwarder = vm.envAddress("CRE_SEPOLIA_FORWARDER");
        address workflowOwner = vm.envAddress("CRE_WORKFLOW_OWNER");
        bytes10 workflowName = bytes10(bytes(vm.envOr("CRE_WORKFLOW_NAME", string(""))));
        address resolver = vm.envAddress("ENS_RESOLVER_ADDRESS");
        string memory parentName = vm.envString("ENS_PARENT_NAME");
        bytes32 parentNode = EnsNamehash.namehash(parentName);

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        writer = new VerdiktScoreWriter(forwarder, workflowOwner, workflowName, resolver, parentNode);
        vm.stopBroadcast();

        console.log("VerdiktScoreWriter:", address(writer));
        console.log("forwarder:         ", forwarder);
        console.log("workflowOwner:     ", workflowOwner);
        console.log("resolver:          ", resolver);
        console.log("parent:            ", parentName);
        console.logBytes32(parentNode);
        console.log("");
        console.log("NOT DONE YET: grant this address the conformance and availability");
        console.log("text roles on each subname, per key, or every publish will revert.");
    }
}
