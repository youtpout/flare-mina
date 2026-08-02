// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BridgeWrapper, BridgeWrapperFactory} from "../src/BridgeWrapper.sol";

contract MockToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev A token that keeps 1% on transfer, to prove the wrapper cannot be
/// tricked into minting against value it never received.
contract FeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount)
        public
        override
        returns (bool)
    {
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount - amount / 100);
        _burn(from, amount / 100);
        return true;
    }
}

contract BridgeWrapperTest is Test {
    BridgeWrapperFactory internal factory;
    MockToken internal weth;
    BridgeWrapper internal wrapper;

    address internal user = address(0xA11CE);

    /// @dev 1e9 underlying base units per wrapper unit, for an 18-decimal token.
    uint256 internal constant SCALE = 1e9;

    function setUp() public {
        factory = new BridgeWrapperFactory();
        weth = new MockToken("Wrapped Ether", "WETH", 18);
        wrapper = factory.deploy(IERC20(address(weth)));

        weth.mint(user, 100 ether);
        vm.prank(user);
        weth.approve(address(wrapper), type(uint256).max);
    }

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    function test_metadata() public view {
        assertEq(wrapper.decimals(), 9);
        assertEq(wrapper.UNDERLYING_DECIMALS(), 18);
        assertEq(wrapper.SCALE(), SCALE);
        assertEq(wrapper.name(), "Bridgeable Wrapped Ether");
        assertEq(wrapper.symbol(), "bWETH");
    }

    /// @dev A token already representable on Mina must not be wrapped: doing so
    /// would add a hop and a liquidity split for nothing.
    function test_rejectsTokenWithNineOrFewerDecimals() public {
        MockToken usdt = new MockToken("USDT0", "USDT0", 6);
        vm.expectRevert(abi.encodeWithSelector(BridgeWrapper.DecimalsTooLow.selector, uint8(6)));
        factory.deploy(IERC20(address(usdt)));

        MockToken nine = new MockToken("Nine", "NINE", 9);
        vm.expectRevert(abi.encodeWithSelector(BridgeWrapper.DecimalsTooLow.selector, uint8(9)));
        factory.deploy(IERC20(address(nine)));
    }

    function test_factoryIsDeterministicAndSingleton() public {
        assertEq(factory.wrapperFor(IERC20(address(weth))), address(wrapper));
        assertTrue(factory.isDeployed(IERC20(address(weth))));

        vm.expectRevert(
            abi.encodeWithSelector(BridgeWrapperFactory.AlreadyDeployed.selector, address(wrapper))
        );
        factory.deploy(IERC20(address(weth)));
    }

    // -------------------------------------------------------------------------
    // Wrapping
    // -------------------------------------------------------------------------

    function test_wrapAndUnwrapRoundTrip() public {
        uint256 amount = 3 ether; // divisible by 1e9

        vm.startPrank(user);
        uint256 minted = wrapper.wrap(amount);
        assertEq(minted, amount / SCALE);
        assertEq(wrapper.balanceOf(user), amount / SCALE);
        assertEq(weth.balanceOf(address(wrapper)), amount);

        uint256 returned = wrapper.unwrap(minted);
        vm.stopPrank();

        assertEq(returned, amount, "round trip must be exact");
        assertEq(weth.balanceOf(user), 100 ether);
        assertEq(wrapper.totalSupply(), 0);
    }

    /// @dev The core guarantee: an amount that would lose dust is refused
    /// outright, rather than silently truncated inside a bridge deposit.
    function test_rejectsAmountThatWouldLoseDust() public {
        uint256 amount = 1 ether + 1; // one wei of dust

        vm.expectRevert(
            abi.encodeWithSelector(BridgeWrapper.AmountNotRepresentable.selector, amount, SCALE)
        );
        vm.prank(user);
        wrapper.wrap(amount);
    }

    function test_roundDownAndDustGuideTheCaller() public view {
        uint256 amount = 1 ether + 123_456_789;
        assertEq(wrapper.dust(amount), 123_456_789);
        assertEq(wrapper.roundDown(amount), 1 ether);
        assertEq(wrapper.roundDown(amount) % SCALE, 0, "rounded amount must be wrappable");
    }

    function test_wrapAcceptsTheRoundedAmount() public {
        uint256 amount = 1 ether + 123_456_789;
        // Computed before the prank: `vm.prank` only covers the next call.
        uint256 rounded = wrapper.roundDown(amount);

        vm.prank(user);
        wrapper.wrap(rounded);
        assertEq(wrapper.balanceOf(user), 1e9);
    }

    function test_rejectsZero() public {
        vm.expectRevert(BridgeWrapper.ZeroAmount.selector);
        vm.prank(user);
        wrapper.wrap(0);
    }

    /// @dev A fee-on-transfer token would leave the wrapper under-backed if the
    /// minted amount were taken from the requested figure rather than measured.
    function test_rejectsFeeOnTransferToken() public {
        FeeToken fee = new FeeToken();
        BridgeWrapper feeWrapper = factory.deploy(IERC20(address(fee)));
        fee.mint(user, 10 ether);

        vm.startPrank(user);
        fee.approve(address(feeWrapper), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeWrapper.FeeOnTransferNotSupported.selector, 1 ether, 1 ether - 0.01 ether
            )
        );
        feeWrapper.wrap(1 ether);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------
    // Backing invariant
    // -------------------------------------------------------------------------

    function testFuzz_alwaysFullyBacked(uint96 raw, uint96 unwrapRaw) public {
        uint256 amount = (uint256(raw) / SCALE) * SCALE;
        vm.assume(amount > 0 && amount <= 100 ether);

        vm.startPrank(user);
        uint256 minted = wrapper.wrap(amount);
        assertTrue(wrapper.fullyBacked());

        uint256 toUnwrap = bound(uint256(unwrapRaw), 0, minted);
        if (toUnwrap > 0) wrapper.unwrap(toUnwrap);
        vm.stopPrank();

        assertTrue(wrapper.fullyBacked(), "wrapper must never be under-backed");
        assertEq(weth.balanceOf(address(wrapper)), (minted - toUnwrap) * SCALE);
    }

    /// @dev A donation of underlying must not break the invariant check.
    function test_donationDoesNotBreakBacking() public {
        vm.prank(user);
        wrapper.wrap(1 ether);

        weth.mint(address(wrapper), 5 ether);
        assertTrue(wrapper.fullyBacked());
    }
}
