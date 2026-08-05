// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {PoseidonPallas} from "../src/libraries/PoseidonPallas.sol";

/// Measures what a Pallas Poseidon costs on an EVM, to decide whether Solidity
/// can maintain a Mina-shaped Merkle structure directly.
contract PoseidonGasTest is Test {
    function _hash(uint256 n) internal view returns (uint256 gasUsed) {
        uint256[] memory input = new uint256[](n);
        for (uint256 i = 0; i < n; i++) input[i] = i + 1;
        uint256 before = gasleft();
        PoseidonPallas.hash(input);
        gasUsed = before - gasleft();
    }

    function testGasByInputLength() public view {
        console.log("poseidon(1 field) gas:", _hash(1));
        console.log("poseidon(2 fields) gas:", _hash(2));
        console.log("poseidon(3 fields) gas:", _hash(3));
        console.log("poseidon(4 fields) gas:", _hash(4));
    }

    /// One IndexedMerkleMap insertion recomputes two paths of ~32 levels.
    function testGasMerklePathEquivalent() public view {
        uint256 total;
        for (uint256 i = 0; i < 32; i++) total += _hash(2);
        console.log("32-level path (32 x 2-field) gas:", total);
        console.log("estimated IndexedMerkleMap insert (2 paths) gas:", total * 2);
    }
}
