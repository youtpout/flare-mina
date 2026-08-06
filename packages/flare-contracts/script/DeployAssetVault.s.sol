// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {AssetVault, IWNat} from "../src/AssetVault.sol";
import {BridgeWrapper} from "../src/BridgeWrapper.sol";

/// @notice Deploys the vault that locks Flare assets for minting on Mina.
///
/// @dev This is the direction the product exists for: Mina has assets but
/// little DeFi, Flare has FXRP and USD₮0 and a working ecosystem, and this is
/// what moves that liquidity across.
///
/// The token list is an allowlist and is set here rather than left open. A swap
/// against an unvetted token risks only the caller; a lock against one mints on
/// Mina, so a transfer hook or a decimal count `UInt64` cannot hold would be a
/// supply bug rather than a bad trade.
///
/// ```sh
/// forge script script/DeployAssetVault.s.sol --rpc-url $COSTON2_RPC_URL --broadcast
/// ```
contract DeployAssetVault is Script {
    /// @dev Coston2. FXRP and USD₮0 are both 6 decimals, so they cross to Mina
    /// unchanged — `UInt64` holds 18 trillion of either. An 18-decimal token
    /// would need `BridgeWrapper` first and is deliberately not listed.
    address internal constant FXRP = 0x0b6A3645c240605887a5532109323A3E12273dc7;
    address internal constant USDT0 = 0xC1A5B41512496B80903D1f32d6dEa3a73212E71F;

    /// @dev Wrapped C2FLR, via `BridgeWrapper`. The native token is not an
    /// ERC-20 and `WNat` — its ERC-20 form — carries 18 decimals, which Mina's
    /// `UInt64` caps at ~18.4 whole tokens. So it crosses through the wrapper
    /// that rounds it to 9, which is what `BridgeWrapper` exists for. Accepting
    /// `WNat` directly would look like it worked and overflow at scale.
    address internal constant WRAPPED_C2FLR = 0x6C790956D728ed82A75d2ec8D5c37F2e2F36b978;

    /// @dev WNat, the ERC-20 form of C2FLR, resolved from the Flare contract
    /// registry. `lockNative` routes native value through it and then through
    /// the wrapper above, so a user never handles either.
    address internal constant WNAT = 0xC67DCE33D7A8efA5FfEB961899C73fe01bCe9273;

    uint256 internal constant COSTON2 = 114;

    function run() external returns (AssetVault vault) {
        require(block.chainid == COSTON2, "this script targets Coston2");

        vm.startBroadcast();

        // The proxy is the permanent address. Each Mina port pins the vault it
        // replays, so moving the vault would strand every wrapped asset.
        AssetVault implementation = new AssetVault();
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            msg.sender,
            abi.encodeCall(AssetVault.initialize, (msg.sender))
        );
        vault = AssetVault(payable(proxy));

        vault.setAccepted(FXRP, true);
        vault.setAccepted(USDT0, true);
        vault.setAccepted(WRAPPED_C2FLR, true);
        vault.setNativeRoute(IWNat(WNAT), BridgeWrapper(WRAPPED_C2FLR));

        vm.stopBroadcast();

        console.log("AssetVault (proxy) :", address(vault));
        console.log("implementation     :", address(implementation));
        console.log("owner              :", msg.sender);
        console.log("accepted           : FXRP, USDT0, bWC2FLR (native routed)");
    }
}
