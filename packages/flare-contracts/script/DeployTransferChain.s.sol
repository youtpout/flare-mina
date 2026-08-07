// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TransferChain} from "../src/TransferChain.sol";
import {AssetVault} from "../src/AssetVault.sol";
import {MinaPortBridge} from "../src/MinaPortBridge.sol";

/// @notice Deploys the shared chain and performs both halves of the handshake.
///
/// @dev Every Flare -> Mina transfer folds here, so one FDC attestation covers
/// every asset that moved instead of one per asset. Wiring is two-sided on
/// purpose: a bridge must point at the chain, *and* the chain must allow that
/// bridge to record that specific token. Either half alone leaves locks
/// reverting, which is the correct failure — a bridge able to append anything
/// could forge a transfer of an asset it does not custody.
///
/// Set FLARE_BRIDGE_ADDRESS and FLARE_ASSET_VAULT_ADDRESS first; both must
/// already be owned by the caller.
///
/// ```sh
/// forge script script/DeployTransferChain.s.sol --rpc-url $COSTON2_RPC_URL --broadcast
/// ```
contract DeployTransferChain is Script {
    address internal constant FXRP = 0x0b6A3645c240605887a5532109323A3E12273dc7;
    address internal constant USDT0 = 0xC1A5B41512496B80903D1f32d6dEa3a73212E71F;
    address internal constant WRAPPED_C2FLR = 0x6C790956D728ed82A75d2ec8D5c37F2e2F36b978;

    uint256 internal constant COSTON2 = 114;

    function run() external returns (TransferChain chain) {
        require(block.chainid == COSTON2, "this script targets Coston2");

        AssetVault vault = AssetVault(payable(vm.envAddress("FLARE_ASSET_VAULT_ADDRESS")));
        MinaPortBridge bridge = MinaPortBridge(payable(vm.envAddress("FLARE_BRIDGE_ADDRESS")));
        address fmina = address(bridge.TOKEN());

        vm.startBroadcast();

        chain = new TransferChain(msg.sender);

        // Per token, so the vault can never record an FMINA transfer and the
        // bridge can never record a wrapped asset.
        chain.setAppender(address(vault), FXRP, true);
        chain.setAppender(address(vault), USDT0, true);
        chain.setAppender(address(vault), WRAPPED_C2FLR, true);
        chain.setAppender(address(bridge), fmina, true);

        vault.setTransferChain(chain);
        bridge.setTransferChain(chain);

        vm.stopBroadcast();

        console.log("TransferChain :", address(chain));
        console.log("FMINA         :", fmina);
        console.log("appenders     : vault(FXRP,USDT0,bWC2FLR), bridge(FMINA)");
        console.log("");
        console.log("Set FLARE_TRANSFER_CHAIN_ADDRESS and FLARE_FMINA_ADDRESS in the relayer env.");
    }
}
