// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ITransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {TransferChain} from "../src/TransferChain.sol";
import {AssetVault} from "../src/AssetVault.sol";
import {MinaPortBridge} from "../src/MinaPortBridge.sol";

/// @notice Moves both rails onto one shared chain, in the only order that works.
///
/// @dev The upgrade has to come first: the deployed implementations have no
/// `setTransferChain`, so wiring before upgrading reverts on a function that
/// does not exist yet. Everything else follows from that.
///
///   1. new implementations for both proxies, and upgrade them
///   2. deploy the chain
///   3. allow each bridge to record the tokens it actually custodies
///   4. point both bridges at the chain
///
/// Step 3 is per (contract, token) rather than per contract: a caller able to
/// append anything could forge a transfer of an asset it does not hold, and the
/// Mina side would verify that forgery faithfully.
///
/// **Run this only when every rail is drained.** The Mina zkApps restart their
/// cursors at zero, so anything the old chains still owed becomes unclaimable —
/// the burn already happened on Flare.
///
/// ```sh
/// forge script script/MigrateToTransferChain.s.sol --rpc-url $COSTON2_RPC_URL --broadcast
/// ```
contract MigrateToTransferChain is Script {
    address internal constant FXRP = 0x0b6A3645c240605887a5532109323A3E12273dc7;
    address internal constant USDT0 = 0xC1A5B41512496B80903D1f32d6dEa3a73212E71F;
    address internal constant WRAPPED_C2FLR = 0x6C790956D728ed82A75d2ec8D5c37F2e2F36b978;

    uint256 internal constant COSTON2 = 114;

    function run() external returns (TransferChain chain) {
        require(block.chainid == COSTON2, "this script targets Coston2");

        address payable vaultProxy = payable(vm.envAddress("FLARE_ASSET_VAULT_ADDRESS"));
        address payable bridgeProxy = payable(vm.envAddress("FLARE_BRIDGE_ADDRESS"));
        ProxyAdmin vaultAdmin = ProxyAdmin(vm.envAddress("FLARE_VAULT_PROXY_ADMIN"));
        ProxyAdmin bridgeAdmin = ProxyAdmin(vm.envAddress("FLARE_BRIDGE_PROXY_ADMIN"));

        AssetVault vault = AssetVault(vaultProxy);
        MinaPortBridge bridge = MinaPortBridge(bridgeProxy);
        address fmina = address(bridge.TOKEN());

        vm.startBroadcast();

        // 1. Upgrade. No initialiser to call: every new field is set below by an
        // owner-only setter, so a reinitialiser would be a second way to write
        // the same state.
        address newVault = address(new AssetVault());
        address newBridge = address(new MinaPortBridge());
        vaultAdmin.upgradeAndCall(ITransparentUpgradeableProxy(vaultProxy), newVault, "");
        bridgeAdmin.upgradeAndCall(ITransparentUpgradeableProxy(bridgeProxy), newBridge, "");

        // 2. The chain itself.
        chain = new TransferChain(msg.sender);

        // 3. Per token, so the vault can never record an FMINA transfer and the
        // bridge can never record a wrapped asset.
        chain.setAppender(vaultProxy, FXRP, true);
        chain.setAppender(vaultProxy, USDT0, true);
        chain.setAppender(vaultProxy, WRAPPED_C2FLR, true);
        chain.setAppender(bridgeProxy, fmina, true);

        // 4. The other half of the handshake.
        vault.setTransferChain(chain);
        bridge.setTransferChain(chain);

        vm.stopBroadcast();

        console.log("TransferChain        :", address(chain));
        console.log("AssetVault impl      :", newVault);
        console.log("MinaPortBridge impl  :", newBridge);
        console.log("FMINA                :", fmina);
        console.log("");
        console.log("Next: migrate the four zkApps, then set FLARE_TRANSFER_CHAIN_ADDRESS.");
    }
}
