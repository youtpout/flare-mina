// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {MinaPortBridge} from "../../src/MinaPortBridge.sol";
import {IMinaSettlementVerifier} from "../../src/interfaces/IMinaSettlementVerifier.sol";

/// Deploys the bridge the way production does — behind a transparent proxy.
/// Instantiating the implementation directly would pass while the deployed
/// system behaved differently: its storage is not the proxy's.
library DeployBridge {
    function deploy(
        address owner,
        IMinaSettlementVerifier verifier,
        bytes32 bridgeId,
        bytes32 genesisActionState
    ) internal returns (MinaPortBridge) {
        MinaPortBridge implementation = new MinaPortBridge();
        // The constructor deploys a ProxyAdmin owned by `owner`; upgrades go
        // through it, never through the bridge.
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            owner,
            abi.encodeCall(
                MinaPortBridge.initialize, (owner, verifier, bridgeId, genesisActionState)
            )
        );
        return MinaPortBridge(address(proxy));
    }
}
