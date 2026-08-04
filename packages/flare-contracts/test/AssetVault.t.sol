// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AssetVault} from "../src/AssetVault.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev A token that keeps 1% of every transfer. Not exotic — plenty of real
/// ERC-20s do this, and crediting the requested amount rather than the received
/// one would mint unbacked supply on Mina.
contract FeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xFEE), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

contract AssetVaultTest is Test {
    AssetVault internal vault;
    MockToken internal token;

    address internal owner = address(0xA11CE);
    address internal user = address(0xBEEF);

    /// @dev A genuine Pallas x coordinate; isOdd == false, so the packed form
    /// is the coordinate itself.
    bytes32 internal constant MINA_RECIPIENT =
        bytes32(uint256(14124943907817976952427102951112060621286297402986099085035387890279416817272));

    function setUp() public {
        vault = new AssetVault(owner);
        token = new MockToken();
        token.mint(user, 1_000e6);

        vm.prank(owner);
        vault.setAccepted(address(token), true);

        vm.prank(user);
        token.approve(address(vault), type(uint256).max);
    }

    function test_locksAndAssignsAClaimId() public {
        vm.prank(user);
        uint256 claimId = vault.lock(address(token), 100e6, MINA_RECIPIENT);

        assertEq(claimId, 0);
        assertEq(vault.lockedOf(address(token)), 100e6);
        assertEq(token.balanceOf(address(vault)), 100e6);
        assertTrue(vault.isSolvent(address(token)));
    }

    function test_claimIdsAreMonotonicAcrossTokens() public {
        MockToken other = new MockToken();
        other.mint(user, 10e6);
        vm.prank(owner);
        vault.setAccepted(address(other), true);
        vm.prank(user);
        other.approve(address(vault), type(uint256).max);

        vm.prank(user);
        assertEq(vault.lock(address(token), 1e6, MINA_RECIPIENT), 0);
        vm.prank(user);
        assertEq(vault.lock(address(other), 1e6, MINA_RECIPIENT), 1);
        vm.prank(user);
        assertEq(vault.lock(address(token), 1e6, MINA_RECIPIENT), 2);
    }

    /// @dev The property this contract exists to get right: credit what
    /// arrived, not what was asked for.
    function test_creditsTheReceivedAmountNotTheRequestedOne() public {
        FeeToken fee = new FeeToken();
        fee.mint(user, 1_000e6);
        vm.prank(owner);
        vault.setAccepted(address(fee), true);
        vm.prank(user);
        fee.approve(address(vault), type(uint256).max);

        vm.prank(user);
        vault.lock(address(fee), 100e6, MINA_RECIPIENT);

        // 1% was taken in flight, so 99e6 arrived and 99e6 is what may be
        // minted on Mina. Crediting 100e6 would be unbacked supply.
        assertEq(vault.lockedOf(address(fee)), 99e6);
        assertEq(fee.balanceOf(address(vault)), 99e6);
        assertTrue(vault.isSolvent(address(fee)));
    }

    function test_rejectsAnUnacceptedToken() public {
        MockToken stranger = new MockToken();
        stranger.mint(user, 1e6);
        vm.prank(user);
        stranger.approve(address(vault), type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(AssetVault.TokenNotAccepted.selector, address(stranger))
        );
        vm.prank(user);
        vault.lock(address(stranger), 1e6, MINA_RECIPIENT);
    }

    /// @dev A malformed key names no Mina account, so accepting it would lock
    /// the user's tokens against a mint nobody can claim.
    function test_rejectsAMalformedMinaRecipient() public {
        vm.expectRevert();
        vm.prank(user);
        vault.lock(address(token), 1e6, bytes32(type(uint256).max));
    }

    function test_rejectsZeroAmount() public {
        vm.expectRevert(AssetVault.ZeroAmount.selector);
        vm.prank(user);
        vault.lock(address(token), 0, MINA_RECIPIENT);
    }

    function test_releasesAndKeepsTheInvariant() public {
        vm.prank(user);
        vault.lock(address(token), 100e6, MINA_RECIPIENT);

        vm.prank(owner);
        vault.release(0, address(token), user, 40e6);

        assertEq(vault.lockedOf(address(token)), 60e6);
        assertEq(token.balanceOf(address(vault)), 60e6);
        assertTrue(vault.isSolvent(address(token)));
    }

    function test_cannotReleaseMoreThanIsLocked() public {
        vm.prank(user);
        vault.lock(address(token), 10e6, MINA_RECIPIENT);

        vm.expectRevert(
            abi.encodeWithSelector(
                AssetVault.InsufficientLocked.selector, address(token), 10e6, 11e6
            )
        );
        vm.prank(owner);
        vault.release(0, address(token), user, 11e6);
    }

    function test_onlyOwnerReleases() public {
        vm.prank(user);
        vault.lock(address(token), 10e6, MINA_RECIPIENT);

        vm.expectRevert();
        vm.prank(user);
        vault.release(0, address(token), user, 1e6);
    }

    /// @dev A donation must never make the vault look insolvent or mintable.
    /// `isSolvent` is `>=` for exactly this reason.
    function test_donationsDoNotAffectTheAccounting() public {
        vm.prank(user);
        vault.lock(address(token), 10e6, MINA_RECIPIENT);

        token.mint(address(vault), 500e6);

        assertEq(vault.lockedOf(address(token)), 10e6, "a donation must not be mintable");
        assertTrue(vault.isSolvent(address(token)));
    }

    function test_pauseBlocksLocking() public {
        vm.prank(owner);
        vault.pause();

        vm.expectRevert();
        vm.prank(user);
        vault.lock(address(token), 1e6, MINA_RECIPIENT);
    }
}
