// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {TransferChain} from "../src/TransferChain.sol";
import {PoseidonPallas} from "../src/libraries/PoseidonPallas.sol";

/// @notice Pins the shared chain to the same fixed vectors as `TransferChain.test.ts`.
///
/// @dev This is the only thing standing between the two chains. Flare folds a
/// transfer in Solidity, Mina replays it in a circuit, and a mint only happens
/// when the two agree on every field — so a disagreement here does not produce a
/// wrong number, it produces a bridge where nothing can ever be claimed. Every
/// expected value was produced by `Poseidon.hashWithPrefix` in o1js, never by
/// this implementation: a test comparing the contract against itself would pass
/// while the bridge was unusable.
contract TransferChainTest is Test {
    TransferChain internal chain;

    address internal owner = address(0xA11CE);
    address internal vault = address(0xDEFEC7);
    address internal sender = address(0xBEEF);

    address internal constant FXRP = 0x8b4abA9C4BD7DD961659b02129beE20c6286e17F;
    address internal constant FMINA = 0x1234567890AbcdEF1234567890aBcdef12345678;

    /// @dev o1js `prefixToField("MinaPortTransferV1")`.
    uint256 internal constant PREFIX = 4297918352702906165387926136531478503123277;

    /// @dev `applyTransfer(0, {index: 0, token: FXRP, x: 1, isOdd: false, amount: 1_000_000})`.
    uint256 internal constant VEC1 =
        16384375983255661953484451000793570174029057839055331727320303929127563660068;

    /// @dev `applyTransfer(VEC1, {index: 1, token: FMINA, x: 2, isOdd: true, amount: 250_000})`.
    uint256 internal constant VEC2 =
        8416979730368417248677395568704319549108660798938386199281841772177762886402;

    function setUp() public {
        chain = new TransferChain(owner);
        vm.startPrank(owner);
        chain.setAppender(vault, FXRP, true);
        chain.setAppender(vault, FMINA, true);
        vm.stopPrank();
    }

    function _fold(uint256 state, uint256 index, address token, uint256 x, uint256 isOdd, uint256 amount)
        internal
        pure
        returns (uint256)
    {
        uint256[] memory f = new uint256[](6);
        (f[0], f[1], f[2], f[3], f[4], f[5]) =
            (state, index, uint256(uint160(token)), x, isOdd, amount);
        return PoseidonPallas.hashWithPrefix(PREFIX, f);
    }

    /// @dev The cross-language check. Mina computes this in a circuit.
    function test_foldMatchesTheMinaCircuit() public pure {
        assertEq(_fold(0, 0, FXRP, 1, 0, 1_000_000), VEC1);
        assertEq(_fold(VEC1, 1, FMINA, 2, 1, 250_000), VEC2);
    }

    /// @dev And `append` must feed the fold those exact fields, in that order.
    /// Checking the primitive alone would pass while the caller passed the
    /// amount where the index belongs.
    function test_appendFoldsTheRecordInTheAgreedOrder() public {
        vm.startPrank(vault);
        (uint256 i0, uint256 h0) =
            chain.append(FXRP, sender, bytes32(uint256(1)), 1, false, 1_000_000);
        (uint256 i1, uint256 h1) =
            chain.append(FMINA, sender, bytes32(uint256(2)), 2, true, 250_000);
        vm.stopPrank();

        assertEq(i0, 0);
        assertEq(h0, VEC1);
        assertEq(i1, 1);
        assertEq(h1, VEC2);
        assertEq(chain.head(), VEC2);
    }

    /// @dev The point of one chain: every asset shares an index space, so an
    /// index names one transfer and no Mina port needs a per-token counter.
    function test_indicesAreGlobalAcrossAssets() public {
        vm.startPrank(vault);
        (uint256 a,) = chain.append(FXRP, sender, bytes32(uint256(1)), 1, false, 1);
        (uint256 b,) = chain.append(FMINA, sender, bytes32(uint256(1)), 1, false, 1);
        (uint256 c,) = chain.append(FXRP, sender, bytes32(uint256(1)), 1, false, 1);
        vm.stopPrank();

        assertEq(a, 0);
        assertEq(b, 1);
        assertEq(c, 2);
    }

    /// @dev The token is in the fold, so the same transfer of a different asset
    /// is a different link. Without it a port could not tell which entries are
    /// its own, and the shared chain would be unusable.
    function test_theTokenIsBoundIntoTheLink() public pure {
        assertTrue(_fold(0, 0, FXRP, 1, 0, 5) != _fold(0, 0, FMINA, 1, 0, 5));
    }

    /// @dev Per token, not per contract. A caller allowed to append anything
    /// could forge a transfer of an asset it does not custody, and the Mina side
    /// would verify that forgery faithfully.
    function test_anAppenderIsBoundToItsToken() public {
        vm.expectRevert(
            abi.encodeWithSelector(TransferChain.NotAnAppender.selector, vault, address(0xDEAD))
        );
        vm.prank(vault);
        chain.append(address(0xDEAD), sender, bytes32(uint256(1)), 1, false, 1);
    }

    function test_strangersCannotAppend() public {
        vm.expectRevert(
            abi.encodeWithSelector(TransferChain.NotAnAppender.selector, sender, FXRP)
        );
        vm.prank(sender);
        chain.append(FXRP, sender, bytes32(uint256(1)), 1, false, 1);
    }

    /// @dev Mina accounts in `UInt64`. A larger amount would be recorded here
    /// and unrepresentable there.
    function test_rejectsAnAmountMinaCannotHold() public {
        vm.expectRevert(TransferChain.AmountExceedsUint64.selector);
        vm.prank(vault);
        chain.append(FXRP, sender, bytes32(uint256(1)), 1, false, uint256(type(uint64).max) + 1);
    }

    /// @dev Order is the whole point of a chain: the same transfers in a
    /// different order must not reach the same head, or a replayed pair would
    /// look like the original.
    function test_theChainIsOrderDependent() public pure {
        uint256 ab = _fold(_fold(0, 0, FXRP, 1, 0, 100), 1, FXRP, 2, 0, 200);
        uint256 ba = _fold(_fold(0, 0, FXRP, 2, 0, 200), 1, FXRP, 1, 0, 100);
        assertTrue(ab != ba);
    }

    /// @dev The reason `hashWithPrefix` is not `hash([prefix, ...fields])`: the
    /// sponge has rate 2, so prepending absorbs the prefix alongside the first
    /// field rather than seeding the state with it.
    function test_prefixIsNotPrependable() public pure {
        uint256[] memory prepended = new uint256[](7);
        (prepended[0], prepended[1], prepended[2]) = (PREFIX, 0, 0);
        (prepended[3], prepended[4], prepended[5], prepended[6]) =
            (uint256(uint160(FXRP)), 1, 0, 1_000_000);
        assertTrue(PoseidonPallas.hash(prepended) != VEC1);
    }

    function test_gasPerLink() public {
        vm.prank(vault);
        uint256 before = gasleft();
        chain.append(FXRP, sender, bytes32(uint256(1)), 1, false, 1_000_000);
        console.log("transfer chain append gas:", before - gasleft());
    }
}
