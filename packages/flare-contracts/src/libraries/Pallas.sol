// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Pallas
/// @notice Arithmetic on the Pallas curve, the curve Mina public keys live on.
///
/// @dev **Why this is affordable on Flare.** The Pallas base field is a 255-bit
/// prime, so it fits in one EVM word and `mulmod`/`addmod` operate on it
/// natively at 8 gas each — no limb decomposition, no bigint library. A scalar
/// multiplication is therefore a few hundred thousand gas rather than the
/// millions a non-native field would cost.
///
/// That is what makes it possible to verify a Mina signature on-chain with no
/// zero-knowledge proof at all. On Ethereum mainnet the same code would be
/// prohibitively expensive; on Flare it costs a fraction of a cent.
///
/// Curve: `y² = x³ + 5` over `Fp`, cofactor 1, so every non-identity point is in
/// the prime-order group and no subgroup check is needed.
library Pallas {
    /// @notice Pallas base field order.
    uint256 internal constant P =
        28948022309329048855892746252171976963363056481941560715954676764349967630337;

    /// @notice Pallas scalar field order (= Vesta's base field).
    uint256 internal constant Q =
        28948022309329048855892746252171976963363056481941647379679742748393362948097;

    /// @notice Curve parameter `b` in `y² = x³ + b`.
    uint256 internal constant B = 5;

    /// @notice Generator, the same point o1js uses.
    uint256 internal constant GX = 1;
    uint256 internal constant GY =
        12418654782883325593414442427049395787963493412651469444558597405572177144507;

    error NotOnCurve();

    /// @notice Jacobian point. The identity is represented by `z == 0`.
    struct Point {
        uint256 x;
        uint256 y;
        uint256 z;
    }

    /// @notice Double a Jacobian point (`a == 0` short-Weierstrass doubling).
    function double(Point memory p) internal pure returns (Point memory r) {
        if (p.z == 0 || p.y == 0) return Point(0, 0, 0);

        uint256 a = mulmod(p.x, p.x, P); // X²
        uint256 b = mulmod(p.y, p.y, P); // Y²
        uint256 c = mulmod(b, b, P); // Y⁴

        // D = 2((X+B)² − A − C)
        uint256 d = addmod(p.x, b, P);
        d = mulmod(d, d, P);
        d = addmod(d, P - a, P);
        d = addmod(d, P - c, P);
        d = addmod(d, d, P);

        uint256 e = mulmod(3, a, P); // E = 3A   (curve a = 0)
        uint256 f = mulmod(e, e, P); // F = E²

        r.x = addmod(f, P - mulmod(2, d, P), P);

        // Y' = E(D − X') − 8C
        uint256 eightC = mulmod(8, c, P);
        r.y = mulmod(e, addmod(d, P - r.x, P), P);
        r.y = addmod(r.y, P - eightC, P);

        r.z = mulmod(2, mulmod(p.y, p.z, P), P);
    }

    /// @notice Add two Jacobian points.
    /// @dev Falls back to {double} when the inputs coincide, which the generic
    /// addition formula cannot handle.
    function add(Point memory p, Point memory q) internal pure returns (Point memory r) {
        if (p.z == 0) return q;
        if (q.z == 0) return p;

        uint256 z1z1 = mulmod(p.z, p.z, P);
        uint256 z2z2 = mulmod(q.z, q.z, P);

        uint256 u1 = mulmod(p.x, z2z2, P);
        uint256 u2 = mulmod(q.x, z1z1, P);
        uint256 s1 = mulmod(p.y, mulmod(z2z2, q.z, P), P);
        uint256 s2 = mulmod(q.y, mulmod(z1z1, p.z, P), P);

        if (u1 == u2) {
            if (s1 != s2) return Point(0, 0, 0); // p == -q
            return double(p);
        }

        uint256 h = addmod(u2, P - u1, P);
        uint256 i = mulmod(2, h, P);
        i = mulmod(i, i, P);
        uint256 j = mulmod(h, i, P);
        uint256 rr = mulmod(2, addmod(s2, P - s1, P), P);
        uint256 v = mulmod(u1, i, P);

        r.x = addmod(mulmod(rr, rr, P), P - j, P);
        r.x = addmod(r.x, P - mulmod(2, v, P), P);

        r.y = mulmod(rr, addmod(v, P - r.x, P), P);
        r.y = addmod(r.y, P - mulmod(2, mulmod(s1, j, P), P), P);

        r.z = mulmod(addmod(p.z, q.z, P), addmod(p.z, q.z, P), P);
        r.z = addmod(r.z, P - z1z1, P);
        r.z = addmod(r.z, P - z2z2, P);
        r.z = mulmod(r.z, h, P);
    }

    /// @notice Scalar multiplication by double-and-add, MSB first.
    ///
    /// @dev Deliberately the simple algorithm. A windowed form with a
    /// precomputed table would cut this substantially for the fixed generator,
    /// but the point of this first version is a trustworthy baseline gas number
    /// to optimise against.
    function mul(Point memory p, uint256 scalar) internal pure returns (Point memory r) {
        r = Point(0, 0, 0);
        if (scalar == 0 || p.z == 0) return r;

        for (uint256 i = 255;; --i) {
            r = double(r);
            if ((scalar >> i) & 1 == 1) {
                r = add(r, p);
            }
            if (i == 0) break;
        }
    }

    /// @notice Negate a point.
    function neg(Point memory p) internal pure returns (Point memory) {
        if (p.z == 0) return p;
        return Point(p.x, P - p.y, p.z);
    }

    /// @notice Convert to affine coordinates.
    /// @dev Costs one field inversion via the `modexp` precompile.
    function toAffine(Point memory p) internal view returns (uint256 x, uint256 y) {
        if (p.z == 0) return (0, 0);
        uint256 zInv = invert(p.z);
        uint256 zInv2 = mulmod(zInv, zInv, P);
        x = mulmod(p.x, zInv2, P);
        y = mulmod(p.y, mulmod(zInv2, zInv, P), P);
    }

    /// @notice Check `affineX == p.x / p.z²` without leaving Jacobian form.
    /// @dev Saves the inversion in {toAffine}: a signature check only needs to
    /// compare `R.x` against `rx`, and `rx·Z² == X` is the same statement.
    function affineXEquals(Point memory p, uint256 affineX) internal pure returns (bool) {
        if (p.z == 0) return false;
        uint256 z2 = mulmod(p.z, p.z, P);
        return mulmod(affineX, z2, P) == p.x;
    }

    /// @notice Modular inverse via Fermat's little theorem, using `modexp` (0x05).
    function invert(uint256 a) internal view returns (uint256 result) {
        uint256[6] memory input = [uint256(32), 32, 32, a, P - 2, P];
        uint256[1] memory output;
        assembly {
            if iszero(staticcall(gas(), 0x05, input, 0xc0, output, 0x20)) { revert(0, 0) }
        }
        result = output[0];
    }

    /// @notice Recover a Mina public key point from `(x, isOdd)` and a
    /// caller-supplied `y`.
    ///
    /// @dev **Why `y` is an argument rather than something we compute.** Solving
    /// `y² = x³ + 5` on-chain needs a modular square root, and the Pallas
    /// modulus is `P ≡ 1 (mod 4)` with 2-adicity 32 — so the cheap
    /// `a^((P+1)/4)` identity does not apply and a full Tonelli-Shanks would
    /// cost far more than the rest of the verification.
    ///
    /// Supplying `y` is free of trust: the two checks below pin it exactly.
    /// `y² == x³ + 5` admits only the two square roots of a real curve point,
    /// and the parity check selects between them. A caller therefore cannot
    /// present anything other than the genuine public key.
    ///
    /// Cost: two `mulmod`s and a comparison, instead of a ~30-iteration
    /// Tonelli-Shanks loop.
    function pointFromKey(uint256 x, bool isOdd, uint256 y)
        internal
        pure
        returns (Point memory)
    {
        if (y >= P || x >= P) revert NotOnCurve();

        uint256 ySquared = addmod(mulmod(mulmod(x, x, P), x, P), B, P);
        if (mulmod(y, y, P) != ySquared) revert NotOnCurve();
        if ((y & 1 == 1) != isOdd) revert NotOnCurve();

        return Point(x, y, 1);
    }

    /// @notice The generator, in Jacobian form.
    function generator() internal pure returns (Point memory) {
        return Point(GX, GY, 1);
    }
}
