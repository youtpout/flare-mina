// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Public values the settlement proof commits to.
/// @dev ABI-identical to `FlareSettlementPublicValues` in `packages/shared`
/// and to the `alloy_sol_types` struct in the Rust prover. The bridge
/// abi-decodes exactly this tuple after the verifier has bound the bytes to a
/// proof.
struct SettlementPublicValues {
    /// @dev Always true in an accepted proof; the bridge checks it anyway so a
    /// verifier that returned public values without asserting validity cannot
    /// silently authorise a mint.
    bool proofValid;
    /// @dev Identifies the Mina bridge zkApp + network this batch came from.
    bytes32 bridgeId;
    /// @dev Mina action state the batch starts from.
    bytes32 previousActionState;
    /// @dev Mina action state the batch ends at.
    bytes32 newActionState;
    /// @dev Merkle root over the keccak deposit leaves in this batch.
    bytes32 depositsRoot;
    /// @dev Strictly monotonic batch counter.
    uint64 batchNonce;
}

/// @notice Verifier abstraction for the Mina -> Flare settlement proof.
/// @dev Kept behind an interface so the bridge can be wired to a mock during
/// frontend development and to the real SP1 Groth16 verifier in production
/// without changing bridge code. Implementations MUST revert on an invalid
/// proof rather than returning false.
interface IMinaSettlementVerifier {
    /// @notice Verify a settlement proof. Reverts if invalid.
    /// @param publicValues ABI-encoded `SettlementPublicValues`.
    /// @param proofBytes The proof (Groth16 for the SP1 implementation).
    function verifySettlement(bytes calldata publicValues, bytes calldata proofBytes) external view;

    /// @notice Identifier of the program/circuit this verifier accepts.
    /// @dev Surfaced so the bridge can emit it on rotation and so off-chain
    /// tooling can detect a verifier swap without reading storage layout.
    function programId() external view returns (bytes32);
}
