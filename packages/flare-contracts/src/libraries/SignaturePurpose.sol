// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title SignaturePurpose
/// @notice Distinct tags for every kind of thing a Mina key can sign.
///
/// @dev **One signature must authorise exactly one kind of action.**
///
/// Every feature in this system asks a Mina key to sign the same shape: a chain
/// id, a target, an action commitment, a nonce and an expiry. Without a purpose
/// tag, two features are kept apart only by their target addresses happening to
/// differ — which is an accident of deployment, not a property of the design.
/// Add a third feature that forgets to differentiate, or deploy two contracts
/// where one is later replaced by the other's address, and a signature meant
/// for one authorises the other.
///
/// The tag makes the separation explicit and impossible to get wrong by
/// omission: it is the FIRST field, so two purposes cannot produce the same
/// signed message regardless of what follows.
///
/// Values are small distinct constants rather than hashes because they are
/// compared as field elements inside a Mina circuit, where a full 32-byte digest
/// would cost two field elements instead of one for no added separation.
library SignaturePurpose {
    /// @notice `MinaAccount.execute` — a single call.
    uint256 internal constant ACCOUNT_CALL = 1;

    /// @notice `MinaAccount.executeBatch` — an ordered list of calls.
    /// @dev Distinct from {ACCOUNT_CALL} so a one-call batch and a lone call are
    /// different statements even though they commit to the same call.
    uint256 internal constant ACCOUNT_BATCH = 2;

    /// @notice `MinaPortBridge.claimWithMinaSignature` — a deposit intent.
    uint256 internal constant DEPOSIT_INTENT = 3;

    /// @notice `AssetVault.releaseWithMinaSignature` — a burn on Mina directed
    /// back to a Flare address.
    uint256 internal constant WITHDRAWAL_INTENT = 4;

    /// @notice Reserved for binding an EVM controller to a Mina key.
    uint256 internal constant CONTROLLER_BINDING = 5;
}
