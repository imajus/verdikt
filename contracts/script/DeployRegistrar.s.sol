// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {VerdiktSubnameRegistrar} from "../src/VerdiktSubnameRegistrar.sol";

/// @notice Deploys VerdiktSubnameRegistrar to Ethereum Sepolia (Tasks.md 5.3
///         stretch 1 — provider self-serve onboarding).
///
/// @dev Usage:
///
///      forge script script/DeployRegistrar.s.sol:DeployRegistrar \
///        --rpc-url sepolia --broadcast
///
///      Environment:
///        DEPLOYER_PRIVATE_KEY  — funded with Sepolia ETH. Does NOT need to be
///                                the `verdikt.eth` operator key — deploying
///                                the contract needs no ENS role at all.
///        SUBNAME_DURATION_SECONDS — optional. Defaults to 365 days, same as
///                                `scripts/onboard-service.mjs`'s onboarding.
///
///      The subname registry, resolver, score writer and parent name are NOT
///      environment variables: they are Verdikt's own Sepolia deployment, read
///      from `deployments/sepolia.json`, the same file the SDK and the ENS
///      scripts read — a second, independently-set source for values already
///      recorded there could only ever disagree with it.
///
///      **Deployment is not finished when this returns.** The contract can
///      only run `claim()` once the operator has granted it:
///
///        subnameRegistry.grantRootRoles(ROLE_REGISTRAR, registrar)
///        resolver.grantRootRoles(RESOLVER_ROLES_VERDIKT_NEEDS, registrar)
///
///      Run `node scripts/grant-registrar-roles.mjs --send` after this, then
///      paste the printed address into `deployments/sepolia.json`'s
///      `subnameRegistrar` — this script does not write that file itself, the
///      same way `DeployScoreWriter` does not write `scoreWriter` itself.
contract DeployRegistrar is Script {
    function run() external returns (VerdiktSubnameRegistrar registrar) {
        uint64 durationSeconds = uint64(vm.envOr("SUBNAME_DURATION_SECONDS", uint256(365 days)));

        string memory deployment = vm.readFile("../deployments/sepolia.json");
        address subnameRegistry = vm.parseJsonAddress(deployment, ".ens.subnameRegistry");
        address resolver = vm.parseJsonAddress(deployment, ".ens.resolver");
        address scoreWriter = vm.parseJsonAddress(deployment, ".scoreWriter");
        string memory parentName = vm.parseJsonString(deployment, ".ens.parentName");

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        registrar = new VerdiktSubnameRegistrar(subnameRegistry, resolver, scoreWriter, parentName, durationSeconds);
        vm.stopBroadcast();

        console.log("VerdiktSubnameRegistrar:", address(registrar));
        console.log("subnameRegistry:        ", subnameRegistry);
        console.log("resolver:                ", resolver);
        console.log("scoreWriter:             ", scoreWriter);
        console.log("parent:                  ", parentName);
        console.log("");
        console.log("NOT DONE YET: run `node scripts/grant-registrar-roles.mjs --send` to");
        console.log("grant this address ROLE_REGISTRAR and the resolver's root roles, then");
        console.log("record its address in deployments/sepolia.json as subnameRegistrar.");
    }
}
