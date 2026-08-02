// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {MinaSchnorr} from "../src/libraries/MinaSchnorr.sol";
import {Pallas} from "../src/libraries/Pallas.sol";

contract SchnorrHarness {
    function verify(
        uint256 pkX,
        bool pkIsOdd,
        uint256 pkY,
        uint256 rx,
        uint256 s,
        uint256[] memory message,
        bool mainnet
    ) external view returns (bool) {
        return MinaSchnorr.verify(
            MinaSchnorr.PublicKey(pkX, pkIsOdd, pkY),
            MinaSchnorr.Signature(rx, s),
            message,
            mainnet
        );
    }

    function domainPrefixToField(string memory prefix) external pure returns (uint256) {
        return MinaSchnorr.domainPrefixToField(prefix);
    }
}

/// @dev End-to-end: a signature produced by o1js `Signature.create` must verify
/// in Solidity. This is the property the whole product rests on — a Mina key
/// gaining authority on Flare without ever producing an ECDSA signature.
contract MinaSchnorrTest is Test {
    SchnorrHarness internal harness;

    // Real o1js signature over the six-field MinaPort authorization shape.
    // PrivateKey.fromBigInt(1234567), message = [114, 0x1111..11, 5, 6, 0, u64max].
    uint256 internal constant PK_X =
        12683775922645730288850699622391131537046165054129306599056287205774802500638;
    uint256 internal constant PK_Y =
        27371841742105741432900768610583339313482342502610165654394081239703524267054;
    bool internal constant PK_IS_ODD = false;
    uint256 internal constant SIG_R =
        11738032433480166249690647790453660187877123390802262700080507538809033183991;
    uint256 internal constant SIG_S =
        10544020464249974147122321120021214656880130718029932681687189735347767074582;

    function setUp() public {
        harness = new SchnorrHarness();
    }

    function _message() internal pure returns (uint256[] memory m) {
        m = new uint256[](6);
        m[0] = 114; // chainId (Coston2)
        m[1] = uint256(uint160(0x1111111111111111111111111111111111111111)); // target
        m[2] = 5; // actionHash hi
        m[3] = 6; // actionHash lo
        m[4] = 0; // nonce
        m[5] = 18446744073709551615; // expiry
    }

    /// @dev Mina pads `"CodaSignature"` to `"CodaSignature*******"`, so the two
    /// must produce the same field element.
    function test_domainPrefixPadding() public view {
        assertEq(
            harness.domainPrefixToField("CodaSignature"),
            harness.domainPrefixToField("CodaSignature*******")
        );
        assertTrue(
            harness.domainPrefixToField("CodaSignature")
                != harness.domainPrefixToField("MinaSignatureMainnet")
        );
    }

    function test_acceptsRealO1jsSignature() public view {
        assertTrue(
            harness.verify(PK_X, PK_IS_ODD, PK_Y, SIG_R, SIG_S, _message(), false),
            "a genuine o1js signature must verify"
        );
    }

    /// @dev Network separation: a devnet signature must not pass as mainnet.
    /// This is what keeps testnet authorizations off a mainnet deployment.
    function test_rejectsWrongNetwork() public view {
        assertFalse(harness.verify(PK_X, PK_IS_ODD, PK_Y, SIG_R, SIG_S, _message(), true));
    }

    function test_rejectsTamperedMessage() public view {
        uint256[] memory m = _message();
        m[4] = 1; // replayed with a different nonce
        assertFalse(harness.verify(PK_X, PK_IS_ODD, PK_Y, SIG_R, SIG_S, m, false));
    }

    function test_rejectsTamperedTarget() public view {
        uint256[] memory m = _message();
        m[1] = uint256(uint160(0x2222222222222222222222222222222222222222));
        assertFalse(harness.verify(PK_X, PK_IS_ODD, PK_Y, SIG_R, SIG_S, m, false));
    }

    function test_rejectsTamperedScalar() public view {
        assertFalse(harness.verify(PK_X, PK_IS_ODD, PK_Y, SIG_R, SIG_S + 1, _message(), false));
    }

    function test_rejectsTamperedRx() public view {
        assertFalse(harness.verify(PK_X, PK_IS_ODD, PK_Y, SIG_R + 1, SIG_S, _message(), false));
    }

    function test_rejectsWrongParity() public {
        vm.expectRevert(Pallas.NotOnCurve.selector);
        harness.verify(PK_X, !PK_IS_ODD, PK_Y, SIG_R, SIG_S, _message(), false);
    }

    function test_rejectsOutOfRangeScalar() public {
        vm.expectRevert(MinaSchnorr.ScalarOutOfRange.selector);
        harness.verify(PK_X, PK_IS_ODD, PK_Y, SIG_R, Pallas.Q, _message(), false);
    }

    function test_gas_verify() public view {
        uint256 before = gasleft();
        harness.verify(PK_X, PK_IS_ODD, PK_Y, SIG_R, SIG_S, _message(), false);
        uint256 used = before - gasleft();
        console.log("full Mina signature verification, 6 fields, gas:", used);
        assertGt(used, 0);
    }
}
