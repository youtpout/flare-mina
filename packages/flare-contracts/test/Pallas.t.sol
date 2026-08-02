// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {Pallas} from "../src/libraries/Pallas.sol";

/// @dev Thin external wrapper so `forge test --gas-report` measures real call
/// gas rather than inlined library code.
contract PallasHarness {
    function mulGenerator(uint256 scalar) external pure returns (uint256, uint256, uint256) {
        Pallas.Point memory r = Pallas.mul(Pallas.generator(), scalar);
        return (r.x, r.y, r.z);
    }

    function mulPoint(uint256 x, bool isOdd, uint256 y, uint256 scalar)
        external
        pure
        returns (uint256, uint256, uint256)
    {
        Pallas.Point memory r = Pallas.mul(Pallas.pointFromKey(x, isOdd, y), scalar);
        return (r.x, r.y, r.z);
    }

    function pointFromKey(uint256 x, bool isOdd, uint256 y)
        external
        pure
        returns (uint256, uint256)
    {
        Pallas.Point memory p = Pallas.pointFromKey(x, isOdd, y);
        return (p.x, p.y);
    }
}

contract PallasTest is Test {
    PallasHarness internal harness;

    /// @dev Real o1js public key: PrivateKey.fromBigInt(1234567).toPublicKey().
    uint256 internal constant PK_X =
        0x1c0ac344a984ffd469d64699d920b83ebaf752b16d08f31345067060c8cb3c1e;
    uint256 internal constant PK_Y =
        0x3c83e9d5746187c2dcdf51719e64a67f6481e28cacac4c35d37718b1e7e0d42e;
    bool internal constant PK_IS_ODD = false;

    function setUp() public {
        harness = new PallasHarness();
    }

    function test_generatorIsOnCurve() public pure {
        uint256 lhs = mulmod(Pallas.GY, Pallas.GY, Pallas.P);
        uint256 rhs = addmod(
            mulmod(mulmod(Pallas.GX, Pallas.GX, Pallas.P), Pallas.GX, Pallas.P),
            Pallas.B,
            Pallas.P
        );
        assertEq(lhs, rhs, "generator must satisfy y^2 = x^3 + 5");
    }

    /// @dev A real o1js key must be accepted with its genuine y coordinate.
    function test_acceptsRealPublicKey() public view {
        (uint256 x, uint256 y) = harness.pointFromKey(PK_X, PK_IS_ODD, PK_Y);
        assertEq(x, PK_X);
        assertEq(y, PK_Y);
    }

    /// @dev A caller cannot substitute the other square root: the parity check
    /// pins which of the two roots is the real key.
    function test_rejectsWrongParity() public {
        vm.expectRevert(Pallas.NotOnCurve.selector);
        harness.pointFromKey(PK_X, !PK_IS_ODD, PK_Y);
    }

    /// @dev A caller cannot supply an arbitrary y: the curve equation pins it.
    function test_rejectsForgedY() public {
        vm.expectRevert(Pallas.NotOnCurve.selector);
        harness.pointFromKey(PK_X, PK_IS_ODD, PK_Y + 1);
    }

    function test_rejectsOffCurveX() public {
        // x = 0 => y^2 = 5, which no y satisfies.
        vm.expectRevert(Pallas.NotOnCurve.selector);
        harness.pointFromKey(0, false, 1);
    }

    function test_rejectsUnreducedCoordinates() public {
        vm.expectRevert(Pallas.NotOnCurve.selector);
        harness.pointFromKey(PK_X, PK_IS_ODD, Pallas.P);
    }

    /// @dev `2G` computed by doubling must equal `mul(G, 2)`.
    function test_scalarMulMatchesDoubling() public view {
        (uint256 x2,, uint256 z2) = harness.mulGenerator(2);
        Pallas.Point memory doubled = Pallas.double(Pallas.generator());
        // Compare projectively: X1/Z1^2 == X2/Z2^2.
        uint256 lhs = mulmod(x2, mulmod(doubled.z, doubled.z, Pallas.P), Pallas.P);
        uint256 rhs = mulmod(doubled.x, mulmod(z2, z2, Pallas.P), Pallas.P);
        assertEq(lhs, rhs);
    }

    /// @dev The headline number: gas for one full-width scalar multiplication.
    /// A worst-case scalar (all bits set) forces an addition at every step.
    function test_gas_scalarMulWorstCase() public view {
        uint256 worstCase = Pallas.Q - 1;
        uint256 before = gasleft();
        harness.mulGenerator(worstCase);
        uint256 used = before - gasleft();
        console.log("scalar mul (worst case) gas:", used);
        assertGt(used, 0);
    }

    function test_gas_scalarMulRealisticScalar() public view {
        uint256 scalar = uint256(keccak256("a realistic 255-bit scalar")) % Pallas.Q;
        uint256 before = gasleft();
        harness.mulGenerator(scalar);
        uint256 used = before - gasleft();
        console.log("scalar mul (random scalar) gas:", used);
        assertGt(used, 0);
    }

    /// @dev Variable-base multiplication on a real Mina public key: the
    /// `e·pk` half of a signature verification.
    function test_gas_variableBaseMul() public view {
        uint256 scalar = uint256(keccak256("scalar")) % Pallas.Q;
        uint256 before = gasleft();
        harness.mulPoint(PK_X, PK_IS_ODD, PK_Y, scalar);
        uint256 used = before - gasleft();
        console.log("key recovery + variable-base scalar mul gas:", used);
        assertGt(used, 0);
    }
}
