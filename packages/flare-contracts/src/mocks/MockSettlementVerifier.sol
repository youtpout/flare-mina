// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMinaSettlementVerifier} from "../interfaces/IMinaSettlementVerifier.sol";

/// @title MockSettlementVerifier
/// @notice Development-only verifier.
///
/// @dev **NEVER DEPLOY THIS TO A NETWORK HOLDING REAL VALUE.** It accepts any
/// proof bytes and therefore lets anyone mint unbacked wMINA. It exists so the
/// frontend, the relayer and the bridge tests can exercise the full deposit and
/// claim flow before the SP1 Groth16 pipeline is wired in.
///
/// The escape hatch is deliberately loud: {isMockVerifier} returns true, the
/// deployment script refuses to use it outside a local chain, and the bridge
/// emits {VerifierUpdated} when it is swapped out.
contract MockSettlementVerifier is IMinaSettlementVerifier {
    /// @notice Set to make the mock reject, so tests can cover the failure path.
    bool public shouldReject;

    error MockRejection();

    /// @notice Unmistakable marker that this is not a real verifier.
    function isMockVerifier() external pure returns (bool) {
        return true;
    }

    function setShouldReject(bool value) external {
        shouldReject = value;
    }

    /// @inheritdoc IMinaSettlementVerifier
    function verifySettlement(bytes calldata, bytes calldata) external view {
        if (shouldReject) revert MockRejection();
    }

    /// @inheritdoc IMinaSettlementVerifier
    function programId() external pure returns (bytes32) {
        return keccak256("MinaPort.MockSettlementVerifier");
    }
}
