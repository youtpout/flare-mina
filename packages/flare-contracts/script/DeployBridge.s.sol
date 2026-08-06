// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {MinaPortBridge} from "../src/MinaPortBridge.sol";
import {BridgeWrapperFactory} from "../src/BridgeWrapper.sol";
import {MockSettlementVerifier} from "../src/mocks/MockSettlementVerifier.sol";
import {IMinaSettlementVerifier} from "../src/interfaces/IMinaSettlementVerifier.sol";

/// @notice Deploys FMINA, the bridge, and the wrapper factory.
///
/// @dev **This script deploys `MockSettlementVerifier`, which accepts any
/// proof.** Anyone can therefore mint unbacked FMINA on whatever chain this
/// runs against. That is acceptable on a testnet where the token has no value
/// and the point is to exercise the claim flow end to end; it is catastrophic
/// anywhere else.
///
/// The script refuses to run on Flare mainnet for that reason. Swapping in the
/// real SP1 verifier is a `proposeVerifier` / `executeVerifierUpdate` pair
/// behind the bridge's two-day timelock — no redeployment, and the rotation is
/// visible on-chain.
///
/// ```sh
/// forge script script/DeployBridge.s.sol --rpc-url $COSTON2_RPC_URL --broadcast
/// ```
contract DeployBridge is Script {
    /// @dev Flare mainnet. Deploying a mock verifier here would be a live mint
    /// exploit, so the script stops rather than trusting the operator's flags.
    uint256 internal constant FLARE_MAINNET = 14;

    function run()
        external
        returns (MinaPortBridge bridge, BridgeWrapperFactory wrappers)
    {
        require(block.chainid != FLARE_MAINNET, "mock verifier must never reach mainnet");

        address owner = msg.sender;

        // Identifies the Mina zkApp and network this bridge serves. Every
        // accepted batch must carry it, so a proof made for one deployment
        // cannot settle on another.
        bytes32 bridgeId = keccak256(abi.encodePacked("FlareXMina.devnet.v1", block.chainid));

        vm.startBroadcast();

        MockSettlementVerifier verifier = new MockSettlementVerifier();

        // The proxy is the permanent address, the implementation replaceable.
        // FMINA is deployed by `initialize` and holds the proxy as its immutable
        // bridge, so upgrading never orphans holders. Transparent rather than
        // UUPS: the upgrade logic lives in the proxy, and the implementation is
        // already close to the EIP-170 limit without it.
        MinaPortBridge implementation = new MinaPortBridge();
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            owner,
            abi.encodeCall(
                MinaPortBridge.initialize,
                (owner, IMinaSettlementVerifier(address(verifier)), bridgeId, bytes32(0))
            )
        );
        bridge = MinaPortBridge(address(proxy));
        wrappers = new BridgeWrapperFactory();

        // Without this the signature deposit path reverts with AttestorNotSet,
        // and only at claim time — long after the deposit has been escrowed.
        address escrowAttestor = vm.envAddress("ESCROW_ATTESTOR");
        bridge.setEscrowAttestor(escrowAttestor);

        vm.stopBroadcast();

        console.log("chain id            :", block.chainid);
        console.log("MockSettlementVerifier:", address(verifier));
        console.log("  ^ ACCEPTS ANY PROOF - testnet only");
        console.log("MinaPortBridge      :", address(bridge), "(proxy)");
        console.log("  implementation    :", address(implementation));
        console.log("  ^ upgrades go through the ProxyAdmin the proxy deployed");
        console.log("FMINA               :", address(bridge.TOKEN()));
        console.log("escrowAttestor      :", escrowAttestor);
        console.log("BridgeWrapperFactory:", address(wrappers));
    }
}
