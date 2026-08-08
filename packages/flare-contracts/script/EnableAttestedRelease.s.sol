// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ITransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {AssetVault} from "../src/AssetVault.sol";

/// @notice Turns on the return leg: a burn on Mina releases the locked asset.
///
/// @dev The ceiling is the whole safety story here, so it is set per token and
/// deliberately. A compromised attestor can sign for a burn that never happened
/// — it cannot redirect or resize a real one, because the holder's Schnorr
/// signature names the token, the recipient and the amount — and this is what
/// bounds that. Zero, the default, refuses everything.
///
/// ```sh
/// forge script script/EnableAttestedRelease.s.sol --rpc-url $COSTON2_RPC_URL --broadcast
/// ```
contract EnableAttestedRelease is Script {
    address internal constant FXRP = 0x0b6A3645c240605887a5532109323A3E12273dc7;
    address internal constant USDT0 = 0xC1A5B41512496B80903D1f32d6dEa3a73212E71F;
    address internal constant WRAPPED_C2FLR = 0x6C790956D728ed82A75d2ec8D5c37F2e2F36b978;

    /// @dev Demo ceilings, in each token's own units. FXRP and USD₮0 are
    /// 6-decimal, so these are 100 of each; the wrapper is 9-decimal, 100 C2FLR.
    uint256 internal constant CAP_6 = 100_000_000;
    uint256 internal constant CAP_9 = 100_000_000_000;

    uint256 internal constant COSTON2 = 114;

    function run() external {
        require(block.chainid == COSTON2, "this script targets Coston2");

        address payable proxy = payable(vm.envAddress("FLARE_ASSET_VAULT_ADDRESS"));
        ProxyAdmin admin = ProxyAdmin(vm.envAddress("FLARE_VAULT_PROXY_ADMIN"));
        address attestor = vm.envAddress("ESCROW_ATTESTOR");

        AssetVault vault = AssetVault(proxy);

        vm.startBroadcast();

        // The release path lives in a new implementation; the proxy keeps its
        // address, which every Mina port pins.
        address implementation = address(new AssetVault());
        admin.upgradeAndCall(ITransparentUpgradeableProxy(proxy), implementation, "");

        vault.setBurnAttestor(attestor);
        vault.setMaxAttestedRelease(FXRP, CAP_6);
        vault.setMaxAttestedRelease(USDT0, CAP_6);
        vault.setMaxAttestedRelease(WRAPPED_C2FLR, CAP_9);

        vm.stopBroadcast();

        console.log("AssetVault impl :", implementation);
        console.log("burn attestor   :", attestor);
        console.log("caps            : 100 FXRP, 100 USDT0, 100 bWC2FLR");
    }
}
