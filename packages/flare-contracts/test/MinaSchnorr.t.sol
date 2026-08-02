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

    // -------------------------------------------------------------------------
    // Network domains
    // -------------------------------------------------------------------------
    //
    // Same key, same message, signed under each Mina network domain. Produced
    // with mina-signer's internal `sign({fields}, sk, network)`, because the
    // public `Client.signFields` hardcodes 'devnet' and ignores the network the
    // client was constructed with (mina-signer 4.1.0, mina-signer.js:120).
    //
    // That hardcoding is the reason MinaPort does NOT rely on Mina's network
    // separation for replay protection: every field signature produced by
    // standard tooling carries the devnet domain, on every network. Binding to
    // a chain comes from `chainId` inside the signed message instead, which the
    // tampering tests above cover.

    uint256 internal constant NET_PK_X =
        14124943907817976952427102951112060621286297402986099085035387890279416817272;
    uint256 internal constant NET_PK_Y =
        13532538400063535811126984083224633472238696242642004927428415804270693307394;
    bool internal constant NET_PK_IS_ODD = false;

    uint256 internal constant DEVNET_R =
        13304164611914535130938368733157689388656020710240660185818379904398393853654;
    uint256 internal constant DEVNET_S =
        16500983812682010824297547808772137180815672996486911131605264699841521639532;

    uint256 internal constant MAINNET_R =
        24818370291340460468248178230779357579831185937238848140843001366327618166477;
    uint256 internal constant MAINNET_S =
        6241273606292709212851365878646268798410702067440984225819596203678351091875;

    function test_acceptsGenuineDevnetSignature() public view {
        assertTrue(
            harness.verify(NET_PK_X, NET_PK_IS_ODD, NET_PK_Y, DEVNET_R, DEVNET_S, _message(), false)
        );
    }

    function test_acceptsGenuineMainnetSignature() public view {
        assertTrue(
            harness.verify(NET_PK_X, NET_PK_IS_ODD, NET_PK_Y, MAINNET_R, MAINNET_S, _message(), true)
        );
    }

    /// @dev The two domains must not be interchangeable in either direction.
    function test_domainsAreNotInterchangeable() public view {
        assertFalse(
            harness.verify(NET_PK_X, NET_PK_IS_ODD, NET_PK_Y, DEVNET_R, DEVNET_S, _message(), true),
            "devnet signature must not verify under the mainnet domain"
        );
        assertFalse(
            harness.verify(NET_PK_X, NET_PK_IS_ODD, NET_PK_Y, MAINNET_R, MAINNET_S, _message(), false),
            "mainnet signature must not verify under the devnet domain"
        );
    }

    function test_gas_verifyMainnet() public view {
        uint256 before = gasleft();
        harness.verify(NET_PK_X, NET_PK_IS_ODD, NET_PK_Y, MAINNET_R, MAINNET_S, _message(), true);
        uint256 used = before - gasleft();
        console.log("mainnet-domain verification gas:", used);
        assertGt(used, 0);
    }

    function test_gas_verify() public view {
        uint256 before = gasleft();
        harness.verify(PK_X, PK_IS_ODD, PK_Y, SIG_R, SIG_S, _message(), false);
        uint256 used = before - gasleft();
        console.log("full Mina signature verification, 6 fields, gas:", used);
        assertGt(used, 0);
    }
}
