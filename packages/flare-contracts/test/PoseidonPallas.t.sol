// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PoseidonPallas} from "../src/libraries/PoseidonPallas.sol";

contract PoseidonHarness {
    function hash(uint256[] memory input) external pure returns (uint256) {
        return PoseidonPallas.hash(input);
    }
}

/// @dev Reference values produced by o1js `Poseidon.hash`. If this suite passes,
/// the Solidity sponge is bit-identical to the one Mina signs with — which is
/// the only thing that makes on-chain signature verification meaningful.
contract PoseidonPallasTest is Test {
    PoseidonHarness internal harness;

    function setUp() public {
        harness = new PoseidonHarness();
    }

    function _one(uint256 a) internal pure returns (uint256[] memory out) {
        out = new uint256[](1);
        out[0] = a;
    }

    function test_matchesO1js_singleField() public view {
        assertEq(
            harness.hash(_one(1)),
            7555220006856562833147743033256142154591945963958408607501861037584894828141
        );
    }

    function test_matchesO1js_zero() public view {
        assertEq(
            harness.hash(_one(0)),
            21565680844461314807147611702860246336805372493508489110556896454939225549736
        );
    }

    function test_matchesO1js_twoFields() public view {
        uint256[] memory input = new uint256[](2);
        input[0] = 1;
        input[1] = 2;
        assertEq(
            harness.hash(input),
            17017029585017630513954937283105772963331887127320430819007921583560430366787
        );
    }

    /// @dev Three fields spans two rate-2 blocks, exercising the absorb loop.
    function test_matchesO1js_threeFields() public view {
        uint256[] memory input = new uint256[](3);
        input[0] = 1;
        input[1] = 2;
        input[2] = 3;
        assertEq(
            harness.hash(input),
            24619730558757750532171846435738270973938732743182802489305079455910969360336
        );
    }

    /// @dev The exact six-field shape of a MinaPort authorization.
    function test_matchesO1js_authorizationShape() public view {
        uint256[] memory input = new uint256[](6);
        input[0] = 114; // chainId (Coston2)
        input[1] = uint256(uint160(0x1111111111111111111111111111111111111111)); // target
        input[2] = 5; // actionHash hi
        input[3] = 6; // actionHash lo
        input[4] = 0; // nonce
        input[5] = 18446744073709551615; // expiry
        assertEq(
            harness.hash(input),
            9428965454234248509831475873612478375683251344045905998688137130460505897065
        );
    }

    function test_gas_hashSixFields() public view {
        uint256[] memory input = new uint256[](6);
        for (uint256 i; i < 6; ++i) input[i] = i + 1;

        uint256 before = gasleft();
        harness.hash(input);
        uint256 used = before - gasleft();
        console.log("poseidon hash, 6 fields (3 permutations) gas:", used);
        assertGt(used, 0);
    }

    function test_gas_hashTwoFields() public view {
        uint256[] memory input = new uint256[](2);
        input[0] = 1;
        input[1] = 2;

        uint256 before = gasleft();
        harness.hash(input);
        uint256 used = before - gasleft();
        console.log("poseidon hash, 2 fields (1 permutation) gas:", used);
        assertGt(used, 0);
    }
}
