// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MinaAuthRegistry} from "../src/MinaAuthRegistry.sol";
import {MinaAccountFactory} from "../src/MinaAccount.sol";

/// @notice Deploys the Mina authorization stack.
///
/// @dev Two contracts, no constructor secrets, no owner, no upgrade path. The
/// registry verifies signatures and tracks nonces; the factory derives account
/// addresses from Mina keys. Neither holds funds and neither has an admin, so
/// there is nothing to configure after deployment and nothing to trust.
///
/// ```sh
/// export COSTON2_RPC_URL=https://coston2-api.flare.network/ext/C/rpc
/// export PRIVATE_KEY=0x...
/// forge script script/DeployAuth.s.sol --rpc-url $COSTON2_RPC_URL --broadcast
/// ```
///
/// Faucet for Coston2 test FLR: https://faucet.flare.network
contract DeployAuth is Script {
    function run() external returns (MinaAuthRegistry registry, MinaAccountFactory factory) {
        vm.startBroadcast();

        registry = new MinaAuthRegistry();
        factory = new MinaAccountFactory(address(registry));

        vm.stopBroadcast();

        console.log("chain id         :", block.chainid);
        console.log("MinaAuthRegistry :", address(registry));
        console.log("MinaAccountFactory:", address(factory));
        console.log("");
        console.log("A Mina key's Flare address is factory.accountOf(x | isOdd << 255),");
        console.log("computable off-chain before any transaction is sent.");
    }
}
