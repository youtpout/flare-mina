// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MinaPortBridge} from "../src/MinaPortBridge.sol";
import {FMINA} from "../src/FMINA.sol";
import {MockSettlementVerifier} from "../src/mocks/MockSettlementVerifier.sol";
import {MinaPortEncoding} from "../src/libraries/MinaPortEncoding.sol";
import {MinaAddressLib} from "../src/libraries/MinaAddress.sol";
import {PoseidonPallas} from "../src/libraries/PoseidonPallas.sol";
import {IMinaSettlementVerifier, SettlementPublicValues} from
    "../src/interfaces/IMinaSettlementVerifier.sol";

contract MinaPortBridgeTest is Test {
    MinaPortBridge internal bridge;
    FMINA internal fmina;
    MockSettlementVerifier internal verifier;

    address internal owner = address(0xA11CE);
    address internal alice = address(0x1111111111111111111111111111111111111111);
    address internal bob = address(0x2222222222222222222222222222222222222222);
    address internal relayer = address(0xBEEF);

    bytes32 internal constant BRIDGE_ID = keccak256("MinaPort.devnet.v1");
    bytes32 internal constant GENESIS = bytes32(uint256(0));

    /// @dev A valid Pallas field element, small enough to read in failures.
    bytes32 internal constant SENDER_X = bytes32(uint256(1));

    function setUp() public {
        verifier = new MockSettlementVerifier();
        bridge = new MinaPortBridge(owner, verifier, BRIDGE_ID, GENESIS);
        fmina = bridge.TOKEN();
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _deposit(uint64 nonce, address recipient, uint64 amount)
        internal
        pure
        returns (MinaPortEncoding.Deposit memory)
    {
        return MinaPortEncoding.Deposit({
            nonce: nonce,
            senderMinaX: SENDER_X,
            senderMinaIsOdd: false,
            recipientFlare: recipient,
            amountNanomina: amount
        });
    }

    /// @dev Two-leaf tree with sorted-pair hashing, matching the TS/Rust builder.
    function _tree(bytes32 a, bytes32 b) internal pure returns (bytes32 root) {
        root = a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _publicValues(bytes32 prev, bytes32 next, bytes32 root, uint64 batchNonce)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            SettlementPublicValues({
                proofValid: true,
                bridgeId: BRIDGE_ID,
                previousActionState: prev,
                newActionState: next,
                depositsRoot: root,
                batchNonce: batchNonce
            })
        );
    }

    function _submitBatch(bytes32 prev, bytes32 next, bytes32 root, uint64 batchNonce) internal {
        vm.prank(relayer);
        bridge.submitDepositBatch(hex"", _publicValues(prev, next, root, batchNonce));
    }

    // -------------------------------------------------------------------------
    // Token
    // -------------------------------------------------------------------------

    function test_tokenMetadata() public view {
        assertEq(fmina.name(), "Flare MINA");
        assertEq(fmina.symbol(), "FMINA");
        // 9 decimals keeps 1 nanomina == 1 FMINA base unit, so the collateral
        // invariant is an exact integer equality.
        assertEq(fmina.decimals(), 9);
        assertEq(fmina.BRIDGE(), address(bridge));
    }

    function test_onlyBridgeCanMint() public {
        vm.expectRevert(FMINA.OnlyBridge.selector);
        vm.prank(alice);
        fmina.mint(alice, 1);
    }

    function test_onlyBridgeCanBurn() public {
        vm.expectRevert(FMINA.OnlyBridge.selector);
        vm.prank(alice);
        fmina.burn(alice, 1);
    }

    // -------------------------------------------------------------------------
    // Batch submission
    // -------------------------------------------------------------------------

    function test_submitBatch_acceptsAndAdvancesState() public {
        bytes32 root = keccak256("root-1");
        bytes32 next = keccak256("state-1");

        _submitBatch(GENESIS, next, root, 1);

        assertEq(bridge.currentMinaActionState(), next);
        assertEq(bridge.lastBatchNonce(), 1);
        assertTrue(bridge.acceptedDepositRoots(root));
    }

    function test_submitBatch_rejectsWrongBridgeId() public {
        bytes memory pv = abi.encode(
            SettlementPublicValues({
                proofValid: true,
                bridgeId: keccak256("other-bridge"),
                previousActionState: GENESIS,
                newActionState: keccak256("s"),
                depositsRoot: keccak256("r"),
                batchNonce: 1
            })
        );
        vm.expectRevert();
        bridge.submitDepositBatch(hex"", pv);
    }

    function test_submitBatch_rejectsDiscontinuousActionState() public {
        _submitBatch(GENESIS, keccak256("state-1"), keccak256("root-1"), 1);
        // Second batch claims to start from genesis again.
        vm.expectRevert();
        bridge.submitDepositBatch(
            hex"", _publicValues(GENESIS, keccak256("state-2"), keccak256("root-2"), 2)
        );
    }

    function test_submitBatch_rejectsNonMonotonicNonce() public {
        bytes32 s1 = keccak256("state-1");
        _submitBatch(GENESIS, s1, keccak256("root-1"), 1);

        // Skipping a nonce is rejected...
        vm.expectRevert();
        bridge.submitDepositBatch(hex"", _publicValues(s1, keccak256("s2"), keccak256("r2"), 3));

        // ...and so is replaying the previous one.
        vm.expectRevert();
        bridge.submitDepositBatch(hex"", _publicValues(s1, keccak256("s2"), keccak256("r2"), 1));
    }

    function test_submitBatch_rejectsDuplicateRoot() public {
        bytes32 root = keccak256("root-1");
        bytes32 s1 = keccak256("state-1");
        _submitBatch(GENESIS, s1, root, 1);

        vm.expectRevert();
        bridge.submitDepositBatch(hex"", _publicValues(s1, keccak256("state-2"), root, 2));
    }

    function test_submitBatch_rejectsWhenVerifierRejects() public {
        verifier.setShouldReject(true);
        vm.expectRevert(MockSettlementVerifier.MockRejection.selector);
        bridge.submitDepositBatch(hex"", _publicValues(GENESIS, keccak256("s"), keccak256("r"), 1));
    }

    function test_submitBatch_rejectsWhenProofValidIsFalse() public {
        bytes memory pv = abi.encode(
            SettlementPublicValues({
                proofValid: false,
                bridgeId: BRIDGE_ID,
                previousActionState: GENESIS,
                newActionState: keccak256("s"),
                depositsRoot: keccak256("r"),
                batchNonce: 1
            })
        );
        vm.expectRevert(MinaPortBridge.InvalidProof.selector);
        bridge.submitDepositBatch(hex"", pv);
    }

    function test_submitBatch_isPermissionless() public {
        // Anyone may advance the bridge: the proof is the authorisation, so a
        // censoring relayer can always be routed around.
        vm.prank(address(0xDEAD));
        bridge.submitDepositBatch(hex"", _publicValues(GENESIS, keccak256("s"), keccak256("r"), 1));
        assertEq(bridge.lastBatchNonce(), 1);
    }

    // -------------------------------------------------------------------------
    // Claiming
    // -------------------------------------------------------------------------

    function test_claimDeposit_mintsToEncodedRecipient() public {
        MinaPortEncoding.Deposit memory d0 = _deposit(0, alice, 1_000_000_000);
        MinaPortEncoding.Deposit memory d1 = _deposit(1, bob, 5);

        bytes32 l0 = bridge.depositLeaf(d0);
        bytes32 l1 = bridge.depositLeaf(d1);
        bytes32 root = _tree(l0, l1);

        _submitBatch(GENESIS, keccak256("s1"), root, 1);

        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = l1;

        // Submitted by a third party: funds still go to the encoded recipient.
        vm.prank(relayer);
        bridge.claimDeposit(d0, root, proof0);

        assertEq(fmina.balanceOf(alice), 1_000_000_000);
        assertEq(fmina.balanceOf(relayer), 0);
        assertTrue(bridge.collateralInvariantHolds());
    }

    function test_claimDeposit_rejectsDoubleClaim() public {
        MinaPortEncoding.Deposit memory d0 = _deposit(0, alice, 100);
        MinaPortEncoding.Deposit memory d1 = _deposit(1, bob, 5);
        bytes32 l0 = bridge.depositLeaf(d0);
        bytes32 l1 = bridge.depositLeaf(d1);
        bytes32 root = _tree(l0, l1);
        _submitBatch(GENESIS, keccak256("s1"), root, 1);

        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = l1;

        bridge.claimDeposit(d0, root, proof0);
        vm.expectRevert(abi.encodeWithSelector(MinaPortBridge.DepositAlreadyClaimed.selector, l0));
        bridge.claimDeposit(d0, root, proof0);
    }

    function test_claimDeposit_rejectsUnacceptedRoot() public {
        MinaPortEncoding.Deposit memory d0 = _deposit(0, alice, 100);
        bytes32[] memory proof = new bytes32[](0);
        bytes32 fakeRoot = bridge.depositLeaf(d0);

        vm.expectRevert(
            abi.encodeWithSelector(MinaPortBridge.DepositRootNotAccepted.selector, fakeRoot)
        );
        bridge.claimDeposit(d0, fakeRoot, proof);
    }

    function test_claimDeposit_rejectsForgedProof() public {
        MinaPortEncoding.Deposit memory d0 = _deposit(0, alice, 100);
        MinaPortEncoding.Deposit memory d1 = _deposit(1, bob, 5);
        bytes32 root = _tree(bridge.depositLeaf(d0), bridge.depositLeaf(d1));
        _submitBatch(GENESIS, keccak256("s1"), root, 1);

        // A deposit that was never in the batch, with a made-up sibling.
        MinaPortEncoding.Deposit memory forged = _deposit(99, alice, 1_000_000_000_000);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = bridge.depositLeaf(d1);

        vm.expectRevert(MinaPortBridge.InvalidMerkleProof.selector);
        bridge.claimDeposit(forged, root, proof);
    }

    /// @dev Tampering with any single leaf field must invalidate the proof.
    function test_claimDeposit_rejectsTamperedAmount() public {
        MinaPortEncoding.Deposit memory d0 = _deposit(0, alice, 100);
        MinaPortEncoding.Deposit memory d1 = _deposit(1, bob, 5);
        bytes32 l1 = bridge.depositLeaf(d1);
        bytes32 root = _tree(bridge.depositLeaf(d0), l1);
        _submitBatch(GENESIS, keccak256("s1"), root, 1);

        d0.amountNanomina = 1_000_000;
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = l1;

        vm.expectRevert(MinaPortBridge.InvalidMerkleProof.selector);
        bridge.claimDeposit(d0, root, proof);
    }

    function test_claimDeposit_rejectsZeroAmount() public {
        MinaPortEncoding.Deposit memory d = _deposit(0, alice, 0);
        bytes32 root = bridge.depositLeaf(d);
        _submitBatch(GENESIS, keccak256("s1"), root, 1);

        vm.expectRevert(MinaPortBridge.ZeroAmount.selector);
        bridge.claimDeposit(d, root, new bytes32[](0));
    }

    // -------------------------------------------------------------------------
    // Withdrawal
    // -------------------------------------------------------------------------

    function _fund(address to, uint64 amount) internal {
        MinaPortEncoding.Deposit memory d = _deposit(0, to, amount);
        bytes32 root = bridge.depositLeaf(d);
        _submitBatch(GENESIS, keccak256("s1"), root, 1);
        bridge.claimDeposit(d, root, new bytes32[](0));
    }

    function test_burnToMina_emitsCanonicalEventAndBurns() public {
        _fund(alice, 1_000_000_000);
        bytes32 minaRecipient = bytes32(uint256(12345));

        // The chain starts empty, so this withdrawal folds into zero. Agreement
        // with o1js is covered in WithdrawalChain.t.sol against fixed vectors.
        uint256[] memory f = new uint256[](5);
        (f[0], f[1], f[2], f[3], f[4]) = (0, 0, 12345, 0, 400_000_000);
        uint256 expectedState = PoseidonPallas.hashWithPrefix(
            4297924978315896314651171907962194736605517, f
        );

        vm.expectEmit(true, true, true, true);
        emit MinaPortBridge.WithdrawToMina(
            0, alice, minaRecipient, 400_000_000, 0, expectedState
        );

        vm.prank(alice);
        uint256 nonce = bridge.burnToMina(400_000_000, minaRecipient);

        assertEq(nonce, 0);
        assertEq(fmina.balanceOf(alice), 600_000_000);
        assertEq(bridge.nextWithdrawalNonce(), 1);
        // Stored, not only emitted: the next withdrawal has to read it back.
        assertEq(bridge.withdrawalActionState(), expectedState);
        assertTrue(bridge.collateralInvariantHolds());
    }

    function test_burnToMina_rejectsZeroAmount() public {
        _fund(alice, 100);
        vm.expectRevert(MinaPortBridge.ZeroAmount.selector);
        vm.prank(alice);
        bridge.burnToMina(0, bytes32(uint256(1)));
    }

    /// @dev A recipient whose `x` is outside the Pallas field matches no Mina
    /// account, so accepting it would burn FMINA against unclaimable escrow.
    function test_burnToMina_rejectsInvalidMinaKey() public {
        _fund(alice, 100);
        bytes32 badRecipient = bytes32(MinaAddressLib.PALLAS_FIELD_ORDER);

        vm.expectRevert(MinaAddressLib.InvalidMinaField.selector);
        vm.prank(alice);
        bridge.burnToMina(50, badRecipient);
    }

    function test_burnToMina_rejectsAmountAboveUint64() public {
        _fund(alice, type(uint64).max);
        vm.expectRevert(MinaPortBridge.AmountExceedsUint64.selector);
        vm.prank(alice);
        bridge.burnToMina(uint256(type(uint64).max) + 1, bytes32(uint256(1)));
    }

    function test_burnToMina_nonceIsMonotonic() public {
        _fund(alice, 1000);
        vm.startPrank(alice);
        assertEq(bridge.burnToMina(1, bytes32(uint256(1))), 0);
        assertEq(bridge.burnToMina(1, bytes32(uint256(1))), 1);
        assertEq(bridge.burnToMina(1, bytes32(uint256(1))), 2);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------
    // Administration
    // -------------------------------------------------------------------------

    function test_pauseBlocksUserFlows() public {
        _fund(alice, 1000);

        vm.prank(owner);
        bridge.pause();

        vm.expectRevert();
        bridge.submitDepositBatch(hex"", _publicValues(GENESIS, bytes32(uint256(9)), bytes32(uint256(9)), 2));

        vm.expectRevert();
        vm.prank(alice);
        bridge.burnToMina(1, bytes32(uint256(1)));

        vm.prank(owner);
        bridge.unpause();

        vm.prank(alice);
        bridge.burnToMina(1, bytes32(uint256(1)));
    }

    function test_onlyOwnerCanPause() public {
        vm.expectRevert();
        vm.prank(alice);
        bridge.pause();
    }

    function test_verifierRotationIsTimelocked() public {
        MockSettlementVerifier next = new MockSettlementVerifier();

        vm.prank(owner);
        bridge.proposeVerifier(next);

        // Too early.
        vm.expectRevert();
        vm.prank(owner);
        bridge.executeVerifierUpdate();

        vm.warp(block.timestamp + bridge.VERIFIER_UPDATE_DELAY());
        vm.prank(owner);
        bridge.executeVerifierUpdate();

        assertEq(address(bridge.verifier()), address(next));
    }

    function test_verifierRotationCanBeCancelled() public {
        MockSettlementVerifier next = new MockSettlementVerifier();
        address before = address(bridge.verifier());

        vm.startPrank(owner);
        bridge.proposeVerifier(next);
        bridge.cancelVerifierUpdate();
        vm.warp(block.timestamp + bridge.VERIFIER_UPDATE_DELAY());
        vm.expectRevert(MinaPortBridge.NoPendingVerifier.selector);
        bridge.executeVerifierUpdate();
        vm.stopPrank();

        assertEq(address(bridge.verifier()), before);
    }

    function test_ownershipIsTwoStep() public {
        vm.prank(owner);
        bridge.transferOwnership(alice);
        // Not owner until accepted.
        assertEq(bridge.owner(), owner);

        vm.prank(alice);
        bridge.acceptOwnership();
        assertEq(bridge.owner(), alice);
    }

    // -------------------------------------------------------------------------
    // Invariant
    // -------------------------------------------------------------------------

    function testFuzz_collateralInvariantHolds(uint64 amount, uint64 burnAmount) public {
        amount = uint64(bound(amount, 1, type(uint64).max / 2));
        burnAmount = uint64(bound(burnAmount, 1, amount));

        _fund(alice, amount);
        assertTrue(bridge.collateralInvariantHolds());

        vm.prank(alice);
        bridge.burnToMina(burnAmount, bytes32(uint256(1)));
        assertTrue(bridge.collateralInvariantHolds());
    }
}
