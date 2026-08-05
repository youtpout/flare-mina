// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MinaPortBridge} from "../../src/MinaPortBridge.sol";
import {IMinaSettlementVerifier} from "../../src/interfaces/IMinaSettlementVerifier.sol";

/// @title DeployBridge
/// @notice Deploys the bridge the way production does — behind a proxy.
///
/// @dev Tests that instantiated the implementation directly would pass while
/// the deployed system behaved differently: the implementation's own storage is
/// not the proxy's, `initialize` is disabled on it, and an immutable read there
/// is not the value the proxy serves. Every suite therefore goes through this.
library DeployBridge {
    function deploy(
        address owner,
        IMinaSettlementVerifier verifier,
        bytes32 bridgeId,
        bytes32 genesisActionState
    ) internal returns (MinaPortBridge) {
        MinaPortBridge implementation = new MinaPortBridge();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(
                MinaPortBridge.initialize, (owner, verifier, bridgeId, genesisActionState)
            )
        );
        return MinaPortBridge(address(proxy));
    }
}
