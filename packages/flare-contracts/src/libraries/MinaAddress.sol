// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice A Mina public key packed into a single EVM word.
/// @dev Layout: `x | (isOdd << 255)`.
///
/// A Mina public key is a Pallas curve point compressed to `(x, isOdd)`. The
/// Pallas base field order is below `2^255`, so bit 255 is always free and the
/// parity bit can be packed there losslessly.
///
/// This is the same scheme as `ZekoAddress` in the ethereum-settlement repo,
/// kept bit-compatible on purpose so both bridges agree on how a Mina account is
/// represented on an EVM chain. The TypeScript mirror is
/// `encodeMinaRecipient` / `decodeMinaRecipient` in `packages/shared`.
type MinaAddress is uint256;

library MinaAddressLib {
    uint256 internal constant SIGN_MASK = 1 << 255;
    uint256 internal constant X_MASK = SIGN_MASK - 1;

    /// @notice Pallas base field order (Fp).
    uint256 internal constant PALLAS_FIELD_ORDER =
        28948022309329048855892746252171976963363056481941560715954676764349967630337;

    error InvalidMinaField();

    /// @notice Pack a curve point into a `MinaAddress`.
    function pack(uint256 x, bool isOdd) internal pure returns (MinaAddress) {
        if (x >= PALLAS_FIELD_ORDER) revert InvalidMinaField();
        return MinaAddress.wrap(x | (isOdd ? SIGN_MASK : 0));
    }

    /// @notice Unpack a `MinaAddress` back into its curve point.
    function unpack(MinaAddress key) internal pure returns (uint256 x, bool isOdd) {
        uint256 packed = MinaAddress.unwrap(key);
        x = packed & X_MASK;
        isOdd = (packed & SIGN_MASK) != 0;
        if (x >= PALLAS_FIELD_ORDER) revert InvalidMinaField();
    }

    /// @notice Raw word, for hashing and event emission.
    function raw(MinaAddress key) internal pure returns (uint256) {
        return MinaAddress.unwrap(key);
    }

    /// @notice Build a `MinaAddress` from a raw word, validating the field element.
    /// @dev Use this on every externally supplied recipient: an unvalidated word
    /// could encode an `x` outside the field, which no Mina account can own, so
    /// the funds would be permanently unclaimable on the Mina side.
    function fromRaw(uint256 packed) internal pure returns (MinaAddress) {
        if ((packed & X_MASK) >= PALLAS_FIELD_ORDER) revert InvalidMinaField();
        return MinaAddress.wrap(packed);
    }

    /// @notice `fromRaw` for the `bytes32` form used across the bridge ABI.
    function fromBytes32(bytes32 packed) internal pure returns (MinaAddress) {
        return fromRaw(uint256(packed));
    }

    /// @notice Non-reverting validity check.
    function isValid(bytes32 packed) internal pure returns (bool) {
        return (uint256(packed) & X_MASK) < PALLAS_FIELD_ORDER;
    }
}
