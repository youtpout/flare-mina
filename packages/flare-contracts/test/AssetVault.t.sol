// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AssetVault, IWNat} from "../src/AssetVault.sol";
import {BridgeWrapper} from "../src/BridgeWrapper.sol";

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

/// @dev WNat as the vault uses it: an 18-decimal ERC-20 over the native token.
contract MockWNat is ERC20 {
    constructor() ERC20("Wrapped C2FLR", "WC2FLR") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "native transfer failed");
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
        // Through the proxy, as deployed: the implementation disables its own
        // initialisers, so testing it directly would test something else.
        vault = AssetVault(
            payable(
                new TransparentUpgradeableProxy(
                    address(new AssetVault()),
                    owner,
                    abi.encodeCall(AssetVault.initialize, (owner))
                )
            )
        );
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

    /// @dev Per token, not global. Each asset's Mina port replays only its own
    /// chain, so a claim id has to be that chain's position or the port would
    /// have to know about assets it does not administer.
    function test_claimIdsAreCountedPerToken() public {
        MockToken other = new MockToken();
        other.mint(user, 10e6);
        vm.prank(owner);
        vault.setAccepted(address(other), true);
        vm.prank(user);
        other.approve(address(vault), type(uint256).max);

        vm.prank(user);
        assertEq(vault.lock(address(token), 1e6, MINA_RECIPIENT), 0);
        vm.prank(user);
        assertEq(vault.lock(address(other), 1e6, MINA_RECIPIENT), 0);
        vm.prank(user);
        assertEq(vault.lock(address(token), 1e6, MINA_RECIPIENT), 1);
    }

    /// @dev The chain is what Mina replays, so its head must move on every lock
    /// and the event must carry both ends of the link.
    function test_lockAdvancesThePoseidonChain() public {
        assertEq(vault.lockActionStateOf(address(token)), 0, "an empty chain starts at zero");

        vm.prank(user);
        vault.lock(address(token), 1e6, MINA_RECIPIENT);
        uint256 first = vault.lockActionStateOf(address(token));
        assertTrue(first != 0);

        vm.prank(user);
        vault.lock(address(token), 1e6, MINA_RECIPIENT);
        uint256 second = vault.lockActionStateOf(address(token));
        assertTrue(second != first, "each lock must extend the chain");
    }

    /// @dev Chains are independent, so activity on one asset must not move
    /// another's head — a Mina port would otherwise stall on a link it cannot
    /// replay.
    function test_chainsDoNotInterfere() public {
        MockToken other = new MockToken();
        other.mint(user, 10e6);
        vm.prank(owner);
        vault.setAccepted(address(other), true);
        vm.prank(user);
        other.approve(address(vault), type(uint256).max);

        vm.prank(user);
        vault.lock(address(token), 1e6, MINA_RECIPIENT);
        assertEq(vault.lockActionStateOf(address(other)), 0);
    }

    /// @dev Mina accounts in `UInt64`. A larger amount would be locked here and
    /// unrepresentable there, so it must be refused at the door.
    function test_rejectsAnAmountMinaCannotHold() public {
        token.mint(user, type(uint256).max - token.totalSupply());

        vm.expectRevert(AssetVault.AmountExceedsUint64.selector);
        vm.prank(user);
        vault.lock(address(token), uint256(type(uint64).max) + 1, MINA_RECIPIENT);
    }

    /// @dev The release path is attested, so replay protection cannot come from
    /// a proof; it comes from the claim id being consumed once.
    function test_aClaimIsReleasedOnlyOnce() public {
        vm.prank(user);
        vault.lock(address(token), 10e6, MINA_RECIPIENT);

        vm.prank(owner);
        vault.release(0, address(token), user, 4e6);

        vm.expectRevert(
            abi.encodeWithSelector(AssetVault.ClaimAlreadyReleased.selector, address(token), 0)
        );
        vm.prank(owner);
        vault.release(0, address(token), user, 4e6);
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

    /// @dev The native round trip. C2FLR is 18 decimals, where a `UInt64` caps
    /// out at 18 whole tokens, so it can only cross as its 9-decimal wrapper —
    /// and the user should never have to know that.
    function test_nativeLocksAndReleasesThroughTheWrapper() public {
        MockWNat wnat = new MockWNat();
        BridgeWrapper wrapper = new BridgeWrapper(IERC20(address(wnat)));

        vm.startPrank(owner);
        vault.setNativeRoute(IWNat(address(wnat)), wrapper);
        vault.setAccepted(address(wrapper), true);
        vm.stopPrank();

        vm.deal(user, 5 ether);
        vm.prank(user);
        uint256 claimId = vault.lockNative{value: 2 ether}(MINA_RECIPIENT);

        // 2e18 underlying at 9 decimals is 2e9 wrapper units — the figure Mina
        // mints, and the one `UInt64` can hold.
        assertEq(claimId, 0);
        assertEq(vault.lockedOf(address(wrapper)), 2e9);
        assertTrue(vault.lockActionStateOf(address(wrapper)) != 0);
        assertTrue(vault.isSolvent(address(wrapper)));

        vm.prank(owner);
        vault.releaseNative(0, payable(user), 2e9);

        assertEq(user.balance, 5 ether, "the round trip must return every wei");
        assertEq(vault.lockedOf(address(wrapper)), 0);
    }

    function test_nativeLockNeedsARoute() public {
        vm.deal(user, 1 ether);
        vm.expectRevert(AssetVault.NativeRouteNotSet.selector);
        vm.prank(user);
        vault.lockNative{value: 1 ether}(MINA_RECIPIENT);
    }

    function test_pauseBlocksLocking() public {
        vm.prank(owner);
        vault.pause();

        vm.expectRevert();
        vm.prank(user);
        vault.lock(address(token), 1e6, MINA_RECIPIENT);
    }
}
