// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MinaSchnorr} from "./libraries/MinaSchnorr.sol";
import {MinaAddressLib} from "./libraries/MinaAddress.sol";
import {Pallas} from "./libraries/Pallas.sol";
import {SignaturePurpose} from "./libraries/SignaturePurpose.sol";

/// @title MinaAuthRegistry
/// @notice Lets a Mina key authorise actions on Flare, by verifying its Schnorr
/// signature directly on-chain.
///
/// @dev **Why this contract exists.** A Mina key is a Pallas key. It cannot
/// produce an ECDSA secp256k1 signature, so it can never control an EOA on an
/// EVM chain. This contract is the bridge across that gap.
///
/// **Why there is no proof.** The Pallas base field is a 255-bit prime, so it
/// fits in one EVM word and `mulmod` handles it natively. Verification costs
/// roughly 809k gas — under a cent on Flare. A zero-knowledge proof would only
/// be worth its complexity on a chain where gas is expensive; see
/// docs/roadmap for where SP1 does earn its place.
///
/// **What a signature does and does not authorise.** It attests that the Mina
/// key signed this exact authorization. Whether the action is appropriate right
/// now is enforced here: chain binding, target binding, expiry and nonce are
/// properties of current chain state, not of the signature.
contract MinaAuthRegistry {
    /// @notice The canonical authorization a Mina key signs.
    /// @dev Field order is protocol. Mirrored by `Authorization::to_fields` in
    /// `minaport-core` (Rust) and by the TypeScript encoder in packages/shared.
    struct Authorization {
        /// @dev EVM chain this authorization is valid on.
        uint256 chainId;
        /// @dev Contract addressed by this authorization.
        address target;
        /// @dev Opaque commitment to the authorised action. Its meaning is the
        /// target contract's business, which is what lets one verifier serve
        /// account binding, swap approval, and anything added later.
        bytes32 actionHash;
        /// @dev Per-key anti-replay nonce, strictly sequential.
        uint64 nonce;
        /// @dev Unix seconds after which the authorization is void.
        uint64 expiry;
    }

    /// @notice Next expected nonce per Mina key, keyed by `x | isOdd << 255`.
    /// @dev Sequential rather than a bitmap: replay becomes impossible with one
    /// storage slot, and the frontend can read the next nonce without an
    /// archive query.
    mapping(bytes32 => uint64) public nextNonce;

    event AuthorizationConsumed(
        bytes32 indexed minaPublicKey,
        address indexed target,
        bytes32 indexed actionHash,
        uint64 nonce
    );

    error WrongChain(uint256 expected, uint256 actual);
    error WrongTarget(address expected, address actual);
    error Expired(uint64 expiry, uint256 nowSeconds);
    error UnexpectedNonce(bytes32 minaPublicKey, uint64 expected, uint64 actual);
    error InvalidSignature();

    /// @notice Field encoding of an authorization: exactly what the Mina key signs.
    ///
    /// @dev Seven Pallas field elements:
    ///
    /// | index | content                          | width    |
    /// |-------|----------------------------------|----------|
    /// | 0     | purpose tag                      | small    |
    /// | 1     | `chainId`                        | 64 bits  |
    /// | 2     | `target`, big-endian             | 160 bits |
    /// | 3     | `actionHash` high 16 bytes       | 128 bits |
    /// | 4     | `actionHash` low 16 bytes        | 128 bits |
    /// | 5     | `nonce`                          | 64 bits  |
    /// | 6     | `expiry`                         | 64 bits  |
    ///
    /// The purpose tag comes first so that no two features can produce the same
    /// signed message, whatever follows. Without it these fields are identical
    /// to the bridge's deposit intent, and the two would be separated only by
    /// their target addresses happening to differ.
    ///
    /// `actionHash` is split across two elements because a 256-bit digest does
    /// not fit in one ~254-bit field: packing it whole would reduce modulo the
    /// field order and let two distinct actions share an encoding.
    ///
    /// The signer's own public key is deliberately absent — Mina's signing
    /// scheme already absorbs `pk.x` and `pk.y` into the challenge, so
    /// repeating it here would add size without adding binding.
    function encodeAuthorization(Authorization calldata auth, uint256 purpose)
        public
        pure
        returns (uint256[] memory fields)
    {
        fields = new uint256[](7);
        fields[0] = purpose;
        fields[1] = auth.chainId;
        fields[2] = uint256(uint160(auth.target));
        fields[3] = uint256(uint128(bytes16(auth.actionHash)));
        fields[4] = uint256(uint128(uint256(auth.actionHash)));
        fields[5] = auth.nonce;
        fields[6] = auth.expiry;
    }

    /// @notice Verify a Mina-signed authorization and consume its nonce.
    ///
    /// @dev Called by the contract acting on the authorization, so `target` is
    /// checked against `msg.sender`. That is what stops an authorization
    /// intended for one contract from being replayed at another: the signer
    /// names its target, and only that target can consume it.
    ///
    /// Anyone may submit the transaction — the signature is the authorisation,
    /// and the submitter cannot influence any field. There is therefore no
    /// relayer to trust and none to be censored by.
    ///
    /// @param publicKey The signer's Mina key. `y` is supplied by the caller and
    ///        pinned by the curve equation plus the parity bit; see
    ///        {Pallas-pointFromKey}.
    /// @param mainnet Which Mina domain the signature was produced under. Note
    ///        that mina-signer's `signFields` always uses the devnet domain
    ///        regardless of its configured network, so this is normally false;
    ///        chain binding comes from `chainId`, not from this flag.
    /// @param purpose Which feature this signature is for. The caller supplies
    ///        it, and it is the first signed field, so a signature issued for
    ///        one purpose can never satisfy another.
    function consume(
        MinaSchnorr.PublicKey calldata publicKey,
        MinaSchnorr.Signature calldata signature,
        Authorization calldata auth,
        uint256 purpose,
        bool mainnet
    ) external returns (bytes32 minaKey) {
        if (auth.chainId != block.chainid) revert WrongChain(block.chainid, auth.chainId);
        if (auth.target != msg.sender) revert WrongTarget(msg.sender, auth.target);
        if (auth.expiry < block.timestamp) revert Expired(auth.expiry, block.timestamp);

        minaKey = bytes32(MinaAddressLib.raw(MinaAddressLib.pack(publicKey.x, publicKey.isOdd)));

        uint64 expected = nextNonce[minaKey];
        if (auth.nonce != expected) revert UnexpectedNonce(minaKey, expected, auth.nonce);

        // Cheap checks first: signature verification is ~809k gas, so every
        // rejectable condition is tested before paying for it.
        if (!MinaSchnorr.verify(publicKey, signature, encodeAuthorization(auth, purpose), mainnet)) {
            revert InvalidSignature();
        }

        nextNonce[minaKey] = expected + 1;
        emit AuthorizationConsumed(minaKey, auth.target, auth.actionHash, auth.nonce);
    }

    /// @notice Verify an authorization without consuming it. For previews.
    function isValid(
        MinaSchnorr.PublicKey calldata publicKey,
        MinaSchnorr.Signature calldata signature,
        Authorization calldata auth,
        uint256 purpose,
        bool mainnet
    ) external view returns (bool) {
        if (auth.chainId != block.chainid) return false;
        if (auth.expiry < block.timestamp) return false;

        bytes32 minaKey =
            bytes32(MinaAddressLib.raw(MinaAddressLib.pack(publicKey.x, publicKey.isOdd)));
        if (auth.nonce != nextNonce[minaKey]) return false;

        return MinaSchnorr.verify(publicKey, signature, encodeAuthorization(auth, purpose), mainnet);
    }

    /// @notice Next nonce for a Mina key given its curve coordinates.
    function nextNonceFor(uint256 x, bool isOdd) external view returns (uint64) {
        return nextNonce[bytes32(MinaAddressLib.raw(MinaAddressLib.pack(x, isOdd)))];
    }
}
