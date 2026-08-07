// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PoseidonLegacy} from "../src/libraries/PoseidonLegacy.sol";
import {PoseidonPallas} from "../src/libraries/PoseidonPallas.sol";

/// @notice What a wallet-displayable signature would cost to verify.
///
/// @dev `signFields` — what this project uses — renders in Auro as a column of
/// raw decimals. `signMessage` renders as text, but a wallet hashes it with
/// Mina's *legacy* Poseidon, which shares nothing with the Kimchi one already
/// deployed here: 63 rounds against 55, x^5 against x^7, 300 round constants
/// against 165, plus an initial round constant and a bit-packed input.
///
/// These measure the two, so the choice is made on a number.
contract PoseidonLegacyTest is Test {
    /// @dev "MinaPort swap on Coston2", packed by `packToFieldsLegacy`.
    uint256 internal constant EXPECTED_FIELD =
        1236574039759895566830717141358095030957054673512494426445;

    function test_packsAMessageLikeMinaSigner() public pure {
        uint256[] memory fields = PoseidonLegacy.packMessage("MinaPort swap on Coston2");
        assertEq(fields.length, 1);
        assertEq(fields[0], EXPECTED_FIELD);
    }

    function test_gas_hashMessage() public view {
        uint256 before = gasleft();
        PoseidonLegacy.hashMessage("MinaPort swap on Coston2");
        console.log("legacy hashMessage  :", before - gasleft());
    }

    /// @dev The comparison that matters: the same work in the hash already
    /// deployed, on two field elements.
    function test_gas_kimchiHash() public view {
        uint256[] memory input = new uint256[](2);
        input[0] = 1;
        input[1] = 2;
        uint256 before = gasleft();
        PoseidonPallas.hash(input);
        console.log("kimchi hash (2)     :", before - gasleft());
    }

    function test_gas_legacyHashTwoFields() public view {
        uint256[] memory input = new uint256[](2);
        input[0] = 1;
        input[1] = 2;
        uint256 before = gasleft();
        PoseidonLegacy.hash(input);
        console.log("legacy hash (2)     :", before - gasleft());
    }

    /// @dev `e` for pk=(1,2), r=3, message "MinaPort swap on Coston2", computed
    /// by mina-signer. If this matches, the Solidity side agrees with what a
    /// wallet actually signs — which is the whole question.
    uint256 internal constant EXPECTED_CHALLENGE =
        21739677761551221772644086537655091134019994392726932228645898673164461776207;

    function test_reproducesTheWalletChallenge() public pure {
        assertEq(
            PoseidonLegacy.challenge(1, 2, 3, "MinaPort swap on Coston2"),
            EXPECTED_CHALLENGE
        );
    }

    function test_gas_challenge() public view {
        uint256 before = gasleft();
        PoseidonLegacy.challenge(1, 2, 3, "MinaPort swap on Coston2");
        console.log("legacy challenge    :", before - gasleft());
    }

    /// @dev `PoseidonLegacy.hash([1, 2])` from mina-signer. Isolates the
    /// permutation from the salt and the packing.
    function test_reproducesTheBarePermutation() public pure {
        uint256[] memory input = new uint256[](2);
        input[0] = 1;
        input[1] = 2;
        assertEq(
            PoseidonLegacy.hash(input),
            838495094252369110158139294302438415903138935316336685655646025408443796285
        );
    }
}
