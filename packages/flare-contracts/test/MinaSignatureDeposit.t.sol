// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {MinaPortBridge} from "../src/MinaPortBridge.sol";
import {FMINA} from "../src/FMINA.sol";
import {MockSettlementVerifier} from "../src/mocks/MockSettlementVerifier.sol";
import {MinaSchnorr} from "../src/libraries/MinaSchnorr.sol";
import {SignaturePurpose} from "../src/libraries/SignaturePurpose.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @dev The Mina -> Flare signature path is a 2-of-2: the depositor's Schnorr
/// signature binds recipient and amount, the attestor asserts the escrow exists.
/// These tests are mostly about what each half CANNOT do alone.
contract MinaSignatureDepositTest is Test {
    MinaPortBridge internal bridge;
    FMINA internal fmina;

    uint256 internal constant CHAIN_ID = 114;
    uint256 internal attestorPk = 0xA77E5704;
    address internal attestor;
    address internal owner = address(0xA11CE);
    address internal recipient = address(0xBEEF);
    uint64 internal constant AMOUNT = 5_000_000_000;

    /// @dev A genuine Pallas x coordinate (isOdd == false, so the packed form is
    /// the coordinate itself), for tests that need a burn to a valid recipient.
    uint256 internal constant PALLAS_X =
        14124943907817976952427102951112060621286297402986099085035387890279416817272;

    struct Signed {
        bytes32 actionHash;
        bool isOdd;
        bytes32 minaKey;
        bytes32 pkX;
        bytes32 pkY;
        bytes32 sigR;
        bytes32 sigS;
    }

    function setUp() public {
        vm.chainId(CHAIN_ID);
        attestor = vm.addr(attestorPk);

        bridge = new MinaPortBridge(
            owner, new MockSettlementVerifier(), keccak256("test"), bytes32(0)
        );
        fmina = bridge.TOKEN();

        vm.prank(owner);
        bridge.setEscrowAttestor(attestor);
    }

    /// @dev A real Mina signature over the bridge's own intent encoding.
    function _signDeposit(address to, uint64 amount, uint64 nonce) internal returns (Signed memory) {
        bytes32 action = keccak256(
            abi.encode(bridge.DEPOSIT_INTENT_DOMAIN(), to, amount)
        );

        // The tool signs (chainId, account, actionHash hi/lo, nonce, expiry).
        // `--action` feeds it the bridge's own intent commitment directly.
        string[] memory a = new string[](8);
        a[0] = "node";
        a[1] = "../shared/tools/signAuthorization.mjs";
        a[2] = "--action";
        a[3] = vm.toString(SignaturePurpose.DEPOSIT_INTENT);
        a[4] = vm.toString(address(bridge));
        a[5] = vm.toString(action);
        a[6] = vm.toString(uint256(nonce));
        a[7] = vm.toString(CHAIN_ID);

        return abi.decode(vm.parseJson(string(vm.ffi(a))), (Signed));
    }

    function _attest(bytes32 minaKey, address to, uint64 amount, uint64 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 intent = keccak256(
            abi.encode(bridge.DEPOSIT_INTENT_DOMAIN(), CHAIN_ID, minaKey, to, amount, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(attestorPk, MessageHashUtils.toEthSignedMessageHash(intent));
        return abi.encodePacked(r, s, v);
    }

    function _claim(Signed memory sig, address to, uint64 amount, uint64 nonce, bytes memory att)
        internal
    {
        bridge.claimWithMinaSignature(
            MinaSchnorr.PublicKey(uint256(sig.pkX), sig.isOdd, uint256(sig.pkY)),
            MinaSchnorr.Signature(uint256(sig.sigR), uint256(sig.sigS)),
            to,
            amount,
            nonce,
            type(uint64).max,
            att
        );
    }

    function test_mintsWhenBothHalvesAgree() public {
        Signed memory sig = _signDeposit(recipient, AMOUNT, 0);
        bytes memory att = _attest(sig.minaKey, recipient, AMOUNT, 0);

        _claim(sig, recipient, AMOUNT, 0, att);

        assertEq(fmina.balanceOf(recipient), AMOUNT);
        assertTrue(bridge.collateralInvariantHolds());
    }

    /// @dev The attestor cannot redirect a deposit to itself or anyone else,
    /// even while attesting perfectly consistently to its own version.
    ///
    /// Note WHICH check stops it: the depositor's Schnorr signature. The
    /// attestation here is internally valid — it names 0xDEAD and is signed for
    /// 0xDEAD — so the ECDSA recovery succeeds. What fails is the Mina
    /// signature, because the depositor signed for `recipient`. That is the
    /// property this path exists to provide, and it is verified on-chain
    /// against Pallas rather than delegated to anyone.
    function test_attestorCannotRedirectTheDeposit() public {
        Signed memory sig = _signDeposit(recipient, AMOUNT, 0);
        bytes memory att = _attest(sig.minaKey, address(0xDEAD), AMOUNT, 0);

        vm.expectRevert(MinaPortBridge.InvalidMinaSignature.selector);
        _claim(sig, address(0xDEAD), AMOUNT, 0, att);
    }

    /// @dev The depositor cannot mint without an attested escrow.
    function test_depositorAloneCannotMint() public {
        Signed memory sig = _signDeposit(recipient, AMOUNT, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBADBAD, keccak256("anything"));

        vm.expectRevert(MinaPortBridge.InvalidAttestation.selector);
        _claim(sig, recipient, AMOUNT, 0, abi.encodePacked(r, s, v));
    }

    /// @dev Nor can it inflate the amount. Again the Schnorr signature is what
    /// refuses: the attestation is self-consistent at ten times the value.
    function test_attestorCannotInflateTheAmount() public {
        Signed memory sig = _signDeposit(recipient, AMOUNT, 0);
        bytes memory att = _attest(sig.minaKey, recipient, AMOUNT * 10, 0);

        vm.expectRevert(MinaPortBridge.InvalidMinaSignature.selector);
        _claim(sig, recipient, AMOUNT * 10, 0, att);
    }

    function test_rejectsReplay() public {
        Signed memory sig = _signDeposit(recipient, AMOUNT, 0);
        bytes memory att = _attest(sig.minaKey, recipient, AMOUNT, 0);

        _claim(sig, recipient, AMOUNT, 0, att);
        vm.expectRevert();
        _claim(sig, recipient, AMOUNT, 0, att);
    }

    // -------------------------------------------------------------------------
    // Mint ceilings
    //
    // These do not make the attestor trustless — nothing on this path does. They
    // convert an unbounded loss into a bounded one that the operator chose, and
    // they are on-chain precisely because the relayer's own policy is worth
    // nothing once the key is out of the relayer's hands.
    // -------------------------------------------------------------------------

    /// @dev A bridge must never be live with an unlimited signature path, so the
    /// ceilings exist before anyone can call a setter.
    function test_limitsAreSetAtConstruction() public view {
        assertEq(bridge.maxAttestedDepositNanomina(), bridge.DEFAULT_MAX_ATTESTED_DEPOSIT());
        assertEq(bridge.attestedMintCapNanomina(), bridge.DEFAULT_ATTESTED_MINT_CAP());
        assertEq(bridge.attestedMintedNanomina(), 0);
    }

    function test_rejectsDepositAbovePerDepositCap() public {
        uint64 cap = 1_000_000_000; // 1 MINA, below AMOUNT
        // Read before the prank: an external call inside the arguments would
        // consume it and leave the setter called by this test contract.
        uint256 cumulative = bridge.attestedMintCapNanomina();
        vm.prank(owner);
        bridge.lowerAttestedMintLimits(cap, cumulative);

        Signed memory sig = _signDeposit(recipient, AMOUNT, 0);
        bytes memory att = _attest(sig.minaKey, recipient, AMOUNT, 0);

        vm.expectRevert(
            abi.encodeWithSelector(MinaPortBridge.DepositAbovePerDepositCap.selector, AMOUNT, cap)
        );
        _claim(sig, recipient, AMOUNT, 0, att);
    }

    /// @dev The cumulative cap is what actually bounds a compromised key: a
    /// per-deposit ceiling alone only forces an attacker to loop.
    function test_rejectsOnceCumulativeCapIsReached() public {
        vm.prank(owner);
        bridge.lowerAttestedMintLimits(AMOUNT, AMOUNT);

        Signed memory first = _signDeposit(recipient, AMOUNT, 0);
        _claim(first, recipient, AMOUNT, 0, _attest(first.minaKey, recipient, AMOUNT, 0));
        assertEq(bridge.remainingAttestedMintAllowance(), 0);

        Signed memory second = _signDeposit(recipient, AMOUNT, 1);
        // Built before `expectRevert`, which otherwise attaches to the external
        // call `_attest` makes to read the domain tag.
        bytes memory att = _attest(second.minaKey, recipient, AMOUNT, 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                MinaPortBridge.AttestedMintCapExceeded.selector,
                uint256(AMOUNT),
                AMOUNT,
                uint256(AMOUNT)
            )
        );
        _claim(second, recipient, AMOUNT, 1, att);
    }

    /// @dev Burning must not refill the allowance. The cap bounds how much the
    /// attestor key can ever have been worth, and a round trip through the
    /// bridge is not evidence that the key stayed honest.
    function test_burningDoesNotRefillTheAllowance() public {
        vm.prank(owner);
        bridge.lowerAttestedMintLimits(AMOUNT, AMOUNT);

        Signed memory sig = _signDeposit(recipient, AMOUNT, 0);
        _claim(sig, recipient, AMOUNT, 0, _attest(sig.minaKey, recipient, AMOUNT, 0));

        // A genuine Pallas x coordinate, so the recipient check passes.
        vm.prank(recipient);
        bridge.burnToMina(AMOUNT, bytes32(uint256(PALLAS_X)));

        assertEq(bridge.remainingAttestedMintAllowance(), 0, "burning must not restore allowance");
    }

    /// @dev Lowering is instant, because reacting to a suspected compromise
    /// within one block is the whole point.
    function test_loweringIsImmediate() public {
        vm.prank(owner);
        bridge.lowerAttestedMintLimits(1, 1);
        assertEq(bridge.maxAttestedDepositNanomina(), 1);
        assertEq(bridge.attestedMintCapNanomina(), 1);
    }

    /// @dev And raising is not, so an attacker holding the owner key can mint
    /// only up to the ceiling already in force.
    function test_raisingRequiresTheTimelock() public {
        uint64 higher = type(uint64).max;

        vm.prank(owner);
        vm.expectRevert(MinaPortBridge.NotARaise.selector);
        bridge.lowerAttestedMintLimits(higher, type(uint256).max);

        vm.prank(owner);
        bridge.proposeAttestedMintLimitsRaise(higher, type(uint256).max);

        vm.prank(owner);
        vm.expectRevert();
        bridge.executeAttestedMintLimitsRaise();

        // Unchanged while pending.
        assertEq(bridge.maxAttestedDepositNanomina(), bridge.DEFAULT_MAX_ATTESTED_DEPOSIT());

        vm.warp(block.timestamp + bridge.VERIFIER_UPDATE_DELAY());
        vm.prank(owner);
        bridge.executeAttestedMintLimitsRaise();

        assertEq(bridge.maxAttestedDepositNanomina(), higher);
        assertEq(bridge.attestedMintCapNanomina(), type(uint256).max);
    }

    function test_onlyOwnerCanTouchLimits() public {
        vm.expectRevert();
        bridge.lowerAttestedMintLimits(1, 1);

        vm.expectRevert();
        bridge.proposeAttestedMintLimitsRaise(type(uint64).max, type(uint256).max);
    }

    function test_rejectsWhenNoAttestorConfigured() public {
        MinaPortBridge fresh = new MinaPortBridge(
            owner, new MockSettlementVerifier(), keccak256("t2"), bytes32(0)
        );
        Signed memory sig = _signDeposit(recipient, AMOUNT, 0);

        vm.expectRevert(MinaPortBridge.AttestorNotSet.selector);
        fresh.claimWithMinaSignature(
            MinaSchnorr.PublicKey(uint256(sig.pkX), sig.isOdd, uint256(sig.pkY)),
            MinaSchnorr.Signature(uint256(sig.sigR), uint256(sig.sigS)),
            recipient, AMOUNT, 0, type(uint64).max, hex"00"
        );
    }
}
