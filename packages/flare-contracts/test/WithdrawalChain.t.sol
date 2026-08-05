// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PoseidonPallas} from "../src/libraries/PoseidonPallas.sol";

/// The withdrawal chain, checked against o1js.
///
/// Flare folds each withdrawal into a running Poseidon commitment and Mina
/// replays it. The two sides must agree bit for bit, so every expected value
/// here was produced by `Poseidon.hashWithPrefix` in o1js rather than by this
/// implementation. A test that compared the contract against itself would pass
/// while the bridge was unusable.
contract WithdrawalChainTest is Test {
    /// o1js `prefixToField("MinaPortWithdrawV1")`.
    uint256 internal constant PREFIX = 4297924978315896314651171907962194736605517;

    function _link(uint256 state, uint256 nonce, uint256 x, uint256 isOdd, uint256 amount)
        internal
        pure
        returns (uint256)
    {
        uint256[] memory f = new uint256[](5);
        (f[0], f[1], f[2], f[3], f[4]) = (state, nonce, x, isOdd, amount);
        return PoseidonPallas.hashWithPrefix(PREFIX, f);
    }

    function testMatchesO1jsFromEmptyChain() public pure {
        assertEq(
            _link(0, 0, 1, 0, 1_000_000_000),
            20338167948893865203789535858143587872632287136678581407774871091195425220612
        );
    }

    /// Also exercises the largest valid Pallas field element and an odd key.
    function testMatchesO1jsMidChain() public pure {
        assertEq(
            _link(
                7,
                1,
                28948022309329048855892746252171976963363056481941560715954676764349967630336,
                1,
                5
            ),
            22763620096517538563887448556698494028164519701847201535409814009599771134055
        );
    }

    /// The reason `hashWithPrefix` is not `hash([prefix, ...fields])`: the sponge
    /// has rate 2, so prepending absorbs the prefix alongside the first field.
    function testPrefixIsNotPrependable() public pure {
        uint256[] memory prepended = new uint256[](6);
        (prepended[0], prepended[1], prepended[2], prepended[3], prepended[4], prepended[5]) =
            (PREFIX, 0, 0, 1, 0, 1_000_000_000);
        assertTrue(PoseidonPallas.hash(prepended) != _link(0, 0, 1, 0, 1_000_000_000));
    }

    /// Order is the whole point of a chain: the same withdrawals in a different
    /// order must not reach the same commitment.
    function testChainIsOrderSensitive() public pure {
        uint256 ab = _link(_link(0, 0, 1, 0, 100), 1, 2, 0, 200);
        uint256 ba = _link(_link(0, 1, 2, 0, 200), 0, 1, 0, 100);
        assertTrue(ab != ba);
    }

    function testGasPerLink() public view {
        uint256 before = gasleft();
        _link(0, 0, 1, 0, 1_000_000_000);
        console.log("withdrawal chain link gas:", before - gasleft());
    }
}
