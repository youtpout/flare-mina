// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {AssetVault} from "../src/AssetVault.sol";
import {PoseidonPallas} from "../src/libraries/PoseidonPallas.sol";

contract ChainToken is ERC20 {
    constructor() ERC20("Chain", "CHN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Pins the lock chain to the same fixed vectors as `LockChain.test.ts`.
///
/// @dev This is the only thing standing between the two chains. Flare folds a
/// lock in Solidity, Mina replays it in a circuit, and a mint only happens when
/// the two agree on every field — so a disagreement here does not produce a
/// wrong number, it produces a bridge where nothing can ever be claimed. Both
/// files carry the same expected values, generated once from o1js.
contract LockChainTest is Test {
    AssetVault internal vault;
    ChainToken internal token;

    address internal owner = address(0xA11CE);
    address internal user = address(0xBEEF);

    uint256 internal constant LOCK_PREFIX_FIELD = 1000684927660458632616681252219213;

    /// @dev `applyLock(0, {claimId: 0, x: 1, isOdd: false, amount: 1_000_000})`.
    uint256 internal constant VEC1 =
        24238330815067196320333506424337783262274560373911706422282298090570990460210;

    /// @dev `applyLock(VEC1, {claimId: 1, x: 2, isOdd: true, amount: 250_000})`.
    uint256 internal constant VEC2 =
        25043209626912400545085844588325141251463434202650320884266165546508507245328;

    function setUp() public {
        vault = AssetVault(
            payable(
                new TransparentUpgradeableProxy(
                    address(new AssetVault()),
                    owner,
                    abi.encodeCall(AssetVault.initialize, (owner))
                )
            )
        );
        token = new ChainToken();
        token.mint(user, 1_000_000_000);

        vm.prank(owner);
        vault.setAccepted(address(token), true);
        vm.prank(user);
        token.approve(address(vault), type(uint256).max);
    }

    function _fold(uint256 state, uint256 claimId, uint256 x, uint256 isOdd, uint256 amount)
        internal
        pure
        returns (uint256)
    {
        uint256[] memory fields = new uint256[](5);
        fields[0] = state;
        fields[1] = claimId;
        fields[2] = x;
        fields[3] = isOdd;
        fields[4] = amount;
        return PoseidonPallas.hashWithPrefix(LOCK_PREFIX_FIELD, fields);
    }

    /// @dev The cross-language check. Mina computes this in a circuit.
    function test_foldMatchesTheMinaCircuit() public pure {
        assertEq(_fold(0, 0, 1, 0, 1_000_000), VEC1);
        assertEq(_fold(VEC1, 1, 2, 1, 250_000), VEC2);
    }

    /// @dev And the vault must feed the fold those exact fields, in that order.
    /// Checking the primitive alone would pass while the caller passed the
    /// amount where the claim id belongs.
    function test_lockFoldsTheRecordInTheAgreedOrder() public {
        vm.prank(user);
        vault.lock(address(token), 1_000_000, bytes32(uint256(1)));

        assertEq(vault.lockActionStateOf(address(token)), VEC1);
    }

    /// @dev Order matters: two locks swapped must not land on the same head, or
    /// a replayed pair would look like the original.
    function test_theChainIsOrderDependent() public {
        uint256 forward = _fold(_fold(0, 0, 1, 0, 7), 1, 1, 0, 9);
        uint256 backward = _fold(_fold(0, 0, 1, 0, 9), 1, 1, 0, 7);
        assertTrue(forward != backward);
    }

    /// @dev A withdrawal and a lock must never fold to the same value, or a
    /// proof of one would settle the other. The domains are what prevent it.
    function test_lockAndWithdrawalDomainsAreDistinct() public pure {
        uint256 withdrawalPrefix = 4297924978315896314651171907962194736605517;
        uint256[] memory fields = new uint256[](5);
        fields[0] = 0;
        fields[1] = 0;
        fields[2] = 1;
        fields[3] = 0;
        fields[4] = 1_000_000;

        assertTrue(
            PoseidonPallas.hashWithPrefix(withdrawalPrefix, fields)
                != PoseidonPallas.hashWithPrefix(LOCK_PREFIX_FIELD, fields)
        );
    }
}
