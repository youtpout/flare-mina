// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {MinaAuthRegistry} from "../src/MinaAuthRegistry.sol";
import {MinaSchnorr} from "../src/libraries/MinaSchnorr.sol";
import {SignaturePurpose} from "../src/libraries/SignaturePurpose.sol";

/// @dev End-to-end: a Mina key authorises an action on Flare, and a Flare
/// contract consumes that authorisation. No proof, no relayer.
contract MinaAuthRegistryTest is Test {
    MinaAuthRegistry internal registry;

    /// @dev The contract the authorization is addressed to.
    address internal constant TARGET = address(0xC0);
    uint256 internal constant CHAIN_ID = 114; // Coston2

    // Real signature from mina-signer over the seven-field authorization below,
    // under SignaturePurpose.ACCOUNT_CALL.
    uint256 internal constant PK_X =
        14124943907817976952427102951112060621286297402986099085035387890279416817272;
    uint256 internal constant PK_Y =
        13532538400063535811126984083224633472238696242642004927428415804270693307394;
    bool internal constant PK_IS_ODD = false;
    uint256 internal constant SIG_R =
        11009910804674032282618832410511253109188501219381188478255295905752492651264;
    uint256 internal constant SIG_S =
        13316799163624626343250698297989255865685064234809081405798832788912931339746;

    /// @dev The SAME message signed under ACCOUNT_BATCH instead. Kept so the
    /// separation can be tested from both directions rather than asserted.
    uint256 internal constant BATCH_SIG_R =
        24235578676038148471832275791968606059459920480319095152124519581041845275154;
    uint256 internal constant BATCH_SIG_S =
        19723336589551823543657351699724349563378033046484034747017976337533281305578;

    bytes32 internal constant ACTION_HASH =
        0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20;

    /// @dev The suite signs account-call authorizations; a different purpose
    /// would need a different signature, which is the point.
    uint256 internal constant PURPOSE = SignaturePurpose.ACCOUNT_CALL;

    function setUp() public {
        registry = new MinaAuthRegistry();
        vm.chainId(CHAIN_ID);
    }

    function _key() internal pure returns (MinaSchnorr.PublicKey memory) {
        return MinaSchnorr.PublicKey(PK_X, PK_IS_ODD, PK_Y);
    }

    function _sig() internal pure returns (MinaSchnorr.Signature memory) {
        return MinaSchnorr.Signature(SIG_R, SIG_S);
    }

    function _auth() internal pure returns (MinaAuthRegistry.Authorization memory) {
        return MinaAuthRegistry.Authorization({
            chainId: CHAIN_ID,
            target: TARGET,
            actionHash: ACTION_HASH,
            nonce: 0,
            expiry: type(uint64).max
        });
    }

    /// @dev The 128/128 split of `actionHash` must be lossless.
    function test_encodingSplitsActionHashLosslessly() public view {
        uint256[] memory f = registry.encodeAuthorization(_auth(), PURPOSE);
        assertEq(f.length, 7);
        assertEq(f[0], PURPOSE, "purpose must be the first signed field");
        assertEq(f[1], CHAIN_ID);
        assertEq(f[2], uint256(uint160(TARGET)));
        assertEq(f[3], 0x0102030405060708090a0b0c0d0e0f10);
        assertEq(f[4], 0x1112131415161718191a1b1c1d1e1f20);
        assertEq((f[3] << 128) | f[4], uint256(ACTION_HASH));
    }

    function test_consumesGenuineAuthorization() public {
        vm.prank(TARGET);
        registry.consume(_key(), _sig(), _auth(), PURPOSE, false);

        assertEq(registry.nextNonceFor(PK_X, PK_IS_ODD), 1, "nonce must advance");
    }

    function test_emitsConsumedEvent() public {
        bytes32 minaKey = bytes32(PK_X); // isOdd == false, so no high bit
        vm.expectEmit(true, true, true, true);
        emit MinaAuthRegistry.AuthorizationConsumed(minaKey, TARGET, ACTION_HASH, 0);

        vm.prank(TARGET);
        registry.consume(_key(), _sig(), _auth(), PURPOSE, false);
    }

    /// @dev The core replay protection: the same signature cannot be used twice.
    function test_rejectsReplay() public {
        vm.prank(TARGET);
        registry.consume(_key(), _sig(), _auth(), PURPOSE, false);

        vm.expectRevert(
            abi.encodeWithSelector(
                MinaAuthRegistry.UnexpectedNonce.selector, bytes32(PK_X), uint64(1), uint64(0)
            )
        );
        vm.prank(TARGET);
        registry.consume(_key(), _sig(), _auth(), PURPOSE, false);
    }

    /// @dev An authorization naming one contract must not be consumable by
    /// another, even though the signature itself is perfectly valid.
    function test_rejectsWrongTarget() public {
        address impostor = address(0xBAD);
        vm.expectRevert(
            abi.encodeWithSelector(MinaAuthRegistry.WrongTarget.selector, impostor, TARGET)
        );
        vm.prank(impostor);
        registry.consume(_key(), _sig(), _auth(), PURPOSE, false);
    }

    /// @dev Chain binding is what actually prevents cross-chain replay, since
    /// Mina's own network separation is absent from field signatures.
    function test_rejectsWrongChain() public {
        vm.chainId(14); // Flare mainnet
        vm.expectRevert(abi.encodeWithSelector(MinaAuthRegistry.WrongChain.selector, 14, CHAIN_ID));
        vm.prank(TARGET);
        registry.consume(_key(), _sig(), _auth(), PURPOSE, false);
    }

    function test_rejectsExpired() public {
        MinaAuthRegistry.Authorization memory auth = _auth();
        auth.expiry = uint64(block.timestamp);
        vm.warp(block.timestamp + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                MinaAuthRegistry.Expired.selector, auth.expiry, block.timestamp
            )
        );
        vm.prank(TARGET);
        registry.consume(_key(), _sig(), auth, PURPOSE, false);
    }

    /// @dev A valid signature over a DIFFERENT action must not be accepted for
    /// this one — the action hash is inside the signed message.
    function test_rejectsTamperedActionHash() public {
        MinaAuthRegistry.Authorization memory auth = _auth();
        auth.actionHash = keccak256("a different action");

        vm.expectRevert(MinaAuthRegistry.InvalidSignature.selector);
        vm.prank(TARGET);
        registry.consume(_key(), _sig(), auth, PURPOSE, false);
    }

    function test_rejectsSignatureFromAnotherKey() public {
        MinaSchnorr.PublicKey memory other = _key();
        // A different, genuine curve point (the o1js vector from MinaSchnorr.t.sol).
        other.x = 12683775922645730288850699622391131537046165054129306599056287205774802500638;
        other.y = 27371841742105741432900768610583339313482342502610165654394081239703524267054;

        vm.expectRevert(MinaAuthRegistry.InvalidSignature.selector);
        vm.prank(TARGET);
        registry.consume(other, _sig(), _auth(), PURPOSE, false);
    }

    /// @dev `isValid` must agree with `consume`, and must not mutate state.
    function test_isValidAgreesAndDoesNotConsume() public {
        assertTrue(registry.isValid(_key(), _sig(), _auth(), PURPOSE, false));
        assertEq(registry.nextNonceFor(PK_X, PK_IS_ODD), 0, "preview must not consume");

        vm.prank(TARGET);
        registry.consume(_key(), _sig(), _auth(), PURPOSE, false);

        // Now the nonce has moved, so the same authorization no longer previews valid.
        assertFalse(registry.isValid(_key(), _sig(), _auth(), PURPOSE, false));
    }

    function test_gas_consume() public {
        vm.prank(TARGET);
        uint256 before = gasleft();
        registry.consume(_key(), _sig(), _auth(), PURPOSE, false);
        uint256 used = before - gasleft();
        console.log("consume() total gas, including storage write:", used);
        assertGt(used, 0);
    }

    /// @dev Cheap checks must run before the ~809k signature verification, so a
    /// rejectable authorization costs a fraction of a valid one.
    function test_gas_rejectionIsCheap() public {
        vm.chainId(14);
        vm.prank(TARGET);
        uint256 before = gasleft();
        try registry.consume(_key(), _sig(), _auth(), PURPOSE, false) {} catch {}
        uint256 used = before - gasleft();
        console.log("rejected-early gas:", used);
        assertLt(used, 100_000, "wrong-chain rejection must not pay for verification");
    }

    // -------------------------------------------------------------------------
    // Purpose separation
    // -------------------------------------------------------------------------

    /// @dev Two features must never share a signature.
    ///
    /// Without the purpose tag these fields are identical to the bridge's
    /// deposit intent, and the two would be kept apart only by their target
    /// addresses happening to differ — an accident of deployment, not a property
    /// of the design. The tag is the first signed field, so the separation holds
    /// whatever follows.
    function test_signatureForOnePurposeDoesNotSatisfyAnother() public {
        // Signed for ACCOUNT_CALL; presented as ACCOUNT_BATCH.
        vm.expectRevert(MinaAuthRegistry.InvalidSignature.selector);
        vm.prank(TARGET);
        registry.consume(_key(), _sig(), _auth(), SignaturePurpose.ACCOUNT_BATCH, false);
    }

    /// @dev And in the other direction, with a genuine batch signature over the
    /// very same message.
    function test_batchSignatureDoesNotSatisfyACall() public {
        MinaSchnorr.Signature memory batchSig =
            MinaSchnorr.Signature(BATCH_SIG_R, BATCH_SIG_S);

        // It is valid for its own purpose...
        assertTrue(
            registry.isValid(_key(), batchSig, _auth(), SignaturePurpose.ACCOUNT_BATCH, false)
        );

        // ...and worthless for any other.
        assertFalse(
            registry.isValid(_key(), batchSig, _auth(), SignaturePurpose.ACCOUNT_CALL, false)
        );
        assertFalse(
            registry.isValid(_key(), batchSig, _auth(), SignaturePurpose.DEPOSIT_INTENT, false)
        );
    }
}
