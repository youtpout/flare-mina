// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Pallas} from "./Pallas.sol";
import {PoseidonPallas} from "./PoseidonPallas.sol";

/// @title MinaSchnorr
/// @notice Verifies a Mina Schnorr signature on-chain, with no zero-knowledge
/// proof anywhere in the path.
///
/// @dev **Why this is possible.** The Pallas base field is a 255-bit prime, so
/// it fits in one EVM word and `mulmod`/`addmod` operate on it natively at 8
/// gas each. Verification is therefore a few hundred thousand gas rather than
/// the millions a non-native field would cost.
///
/// **Why it is a Flare answer, not a general one.** At Flare's gas prices this
/// costs a fraction of a cent. The identical code on Ethereum mainnet would
/// cost tens of dollars per verification, where a Groth16 proof at ~200k gas
/// wins. The choice is a property of the chain, not of the cryptography.
///
/// The scheme, matching `mina_signer` and o1js `Signature.verify`:
///
/// ```text
/// e = Poseidon(prefix; msg ‖ pk.x ‖ pk.y ‖ rx)   reinterpreted in the scalar field
/// R = s·G − e·pk
/// accept iff R ≠ ∞ ∧ R.y is even ∧ R.x == rx
/// ```
library MinaSchnorr {
    /// @notice Domain prefix for testnet/devnet signatures.
    /// @dev o1js `Signature.create` targets this network by default.
    string internal constant TESTNET_PREFIX = "CodaSignature";
    /// @notice Domain prefix for mainnet signatures.
    string internal constant MAINNET_PREFIX = "MinaSignatureMainnet";

    /// @notice Width Mina pads domain prefixes to, with `*`.
    uint256 internal constant DOMAIN_PREFIX_WIDTH = 20;

    error InvalidSignature();
    error ScalarOutOfRange();

    /// @notice A Mina public key, decompressed.
    /// @dev `y` is supplied by the caller rather than derived: see
    /// {Pallas-pointFromKey} for why that is both necessary and safe.
    struct PublicKey {
        uint256 x;
        bool isOdd;
        uint256 y;
    }

    struct Signature {
        uint256 rx;
        uint256 s;
    }

    /// @notice Turn a domain prefix into the field element Mina absorbs.
    ///
    /// @dev The prefix is right-padded with `*` to exactly 20 characters, then
    /// the ASCII bytes are read LITTLE-endian as a field element. Padding to 20
    /// rather than to the field width is what makes `"CodaSignature"` and
    /// `"CodaSignature*******"` hash identically, which Mina's own tests assert.
    function domainPrefixToField(string memory prefix) internal pure returns (uint256) {
        bytes memory p = bytes(prefix);
        require(p.length <= DOMAIN_PREFIX_WIDTH, "prefix too long");

        uint256 value;
        // Little-endian: byte i contributes to bits [8i, 8i+8).
        for (uint256 i; i < DOMAIN_PREFIX_WIDTH; ++i) {
            uint8 c = i < p.length ? uint8(p[i]) : uint8(0x2a); // '*'
            value |= uint256(c) << (8 * i);
        }
        return value;
    }

    /// @notice Compute the challenge scalar `e`.
    ///
    /// @dev Mirrors `mina_hasher`'s init/update/digest sequence exactly:
    /// absorb the network prefix and squeeze (salting the sponge, the squeezed
    /// value deliberately discarded), then absorb `msg ‖ pk.x ‖ pk.y ‖ rx` and
    /// squeeze the digest.
    ///
    /// The digest is a base-field element reinterpreted in the scalar field.
    /// That is sound because the two Pasta moduli differ by less than `2^126`,
    /// so the probability a squeezed value needs reduction is negligible — the
    /// same argument, and the same conversion, `mina_signer` makes.
    function challenge(
        uint256[] memory message,
        PublicKey memory publicKey,
        uint256 rx,
        bool mainnet
    ) internal pure returns (uint256) {
        bytes memory rc = PoseidonPallas.loadConstants();
        uint256[3] memory state = [uint256(0), 0, 0];

        // Salt with the network domain.
        uint256[] memory prefix = new uint256[](1);
        prefix[0] = domainPrefixToField(mainnet ? MAINNET_PREFIX : TESTNET_PREFIX);
        PoseidonPallas.absorb(state, prefix, rc);

        // Absorb the signed content.
        uint256[] memory body = new uint256[](message.length + 3);
        for (uint256 i; i < message.length; ++i) body[i] = message[i];
        body[message.length] = publicKey.x;
        body[message.length + 1] = publicKey.y;
        body[message.length + 2] = rx;
        PoseidonPallas.absorb(state, body, rc);

        return state[0] % Pallas.Q;
    }

    /// @notice Verify a Mina Schnorr signature. Returns false rather than
    /// reverting on a bad signature, so callers can branch.
    ///
    /// @dev Reverts only on structurally invalid input — a public key that is
    /// not a curve point, or a scalar outside the field.
    function verify(
        PublicKey memory publicKey,
        Signature memory signature,
        uint256[] memory message,
        bool mainnet
    ) internal view returns (bool) {
        if (signature.s >= Pallas.Q || signature.rx >= Pallas.P) revert ScalarOutOfRange();

        Pallas.Point memory key = Pallas.pointFromKey(publicKey.x, publicKey.isOdd, publicKey.y);

        uint256 e = challenge(message, publicKey, signature.rx, mainnet);

        // R = s·G − e·pk, as a single interleaved scalar multiplication.
        // Negating the key rather than the result lets both terms share one
        // doubling chain (see {Pallas-mulAdd}).
        Pallas.Point memory r =
            Pallas.mulAdd(Pallas.generator(), signature.s, Pallas.neg(key), e);

        if (r.z == 0) return false;

        // R.y must be even. Recovering the affine y costs one inversion; there
        // is no way around it, since parity is not preserved by the Jacobian
        // representation.
        (, uint256 ry) = Pallas.toAffine(r);
        if (ry & 1 == 1) return false;

        // Compare R.x against rx without a second inversion.
        return Pallas.affineXEquals(r, signature.rx);
    }

    /// @notice {verify}, reverting instead of returning false.
    function requireValid(
        PublicKey memory publicKey,
        Signature memory signature,
        uint256[] memory message,
        bool mainnet
    ) internal view {
        if (!verify(publicKey, signature, message, mainnet)) revert InvalidSignature();
    }
}
