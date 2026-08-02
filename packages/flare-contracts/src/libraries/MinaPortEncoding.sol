// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MinaPortEncoding
/// @notice Canonical cross-chain encodings. This library is consensus-critical:
/// every digest it produces must match, byte for byte, the mirror in
/// the TypeScript `packages/shared/src/encoding.ts` and the Rust mirror in `minaport-core`.
///
/// `packages/shared/fixtures/deposit-batch.json` is the shared test vector; the
/// Foundry suite reads it directly, so a drift in any of the three
/// implementations fails a test rather than silently stranding user funds.
library MinaPortEncoding {
    /// @notice Domain tag for deposit leaves: `keccak256("MinaPort.Deposit.v1")`.
    bytes32 internal constant DEPOSIT_LEAF_DOMAIN = keccak256("MinaPort.Deposit.v1");

    /// @notice Domain tag for withdrawal records: `keccak256("MinaPort.Withdrawal.v1")`.
    bytes32 internal constant WITHDRAWAL_LEAF_DOMAIN = keccak256("MinaPort.Withdrawal.v1");

    /// @notice Padding leaf for the deposit tree: `keccak256("MinaPort.EmptyLeaf.v1")`.
    bytes32 internal constant EMPTY_LEAF = keccak256("MinaPort.EmptyLeaf.v1");

    /// @notice A Mina -> Flare deposit, in its canonical cross-chain form.
    struct Deposit {
        /// @dev Nonce assigned by the Mina bridge zkApp. Monotonic, so every
        /// deposit leaf is unique even for identical (sender, recipient, amount).
        uint64 nonce;
        /// @dev Depositor's Mina public key `x`, big-endian.
        bytes32 senderMinaX;
        /// @dev Depositor's Mina public key parity bit.
        bool senderMinaIsOdd;
        /// @dev Flare address entitled to claim the minted FMINA.
        address recipientFlare;
        /// @dev Amount in nanomina. FMINA uses the same base unit, 1:1.
        uint64 amountNanomina;
    }

    /// @notice Hash a deposit leaf.
    /// @dev The preimage is six ABI words (192 bytes) while internal Merkle
    /// nodes hash exactly 64 bytes, so a leaf digest can never be produced by
    /// hashing a node pair. That is what makes the sorted-pair tree
    /// second-preimage resistant.
    function hashDepositLeaf(Deposit memory deposit) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DEPOSIT_LEAF_DOMAIN,
                deposit.nonce,
                deposit.senderMinaX,
                deposit.senderMinaIsOdd,
                deposit.recipientFlare,
                deposit.amountNanomina
            )
        );
    }

    /// @notice Hash a withdrawal record (Flare -> Mina direction).
    function hashWithdrawal(uint64 nonce, address sender, bytes32 minaRecipient, uint64 amountNanomina)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(WITHDRAWAL_LEAF_DOMAIN, nonce, sender, minaRecipient, amountNanomina)
        );
    }
}
