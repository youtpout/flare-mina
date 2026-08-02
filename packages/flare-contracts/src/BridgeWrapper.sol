// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BridgeWrapper
/// @notice A 9-decimal ERC-20 wrapper, so any Flare asset can cross to Mina.
///
/// @dev **Why 9 decimals is the bridge's universal unit.** Mina's fungible token
/// standard represents balances as `UInt64`, which caps a supply at about
/// 1.845e19 base units. At 18 decimals that is 18.4 whole tokens in existence —
/// WETH simply cannot be represented. At 9 decimals the same cap allows 18
/// billion whole tokens, which is comfortable for every asset we care about, and
/// it is already MINA's own precision.
///
/// **Why a wrapper rather than rescaling inside the bridge.** Going from 18
/// decimals to 9 discards the low 9 digits. Doing that silently inside a bridge
/// deposit would destroy user funds in a place no one is looking. Here the
/// truncation cannot happen at all: {wrap} rejects any amount that is not an
/// exact multiple of the scale factor, so the user converts a clean amount
/// deliberately, before the bridge is ever involved. The bridge then only ever
/// handles 9-decimal tokens and needs no per-asset decimal logic.
///
/// Wrapping is fully reversible and 1:1 in value: `SCALE` underlying base units
/// in, one wrapper base unit out, and the reverse on the way back.
contract BridgeWrapper is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Decimals every asset has once it is ready to cross to Mina.
    uint8 public constant BRIDGE_DECIMALS = 9;

    /// @notice The wrapped token.
    IERC20 public immutable UNDERLYING;

    /// @notice Decimals of the underlying token.
    uint8 public immutable UNDERLYING_DECIMALS;

    /// @notice Underlying base units per wrapper base unit: `10 ** (d - 9)`.
    uint256 public immutable SCALE;

    error DecimalsTooLow(uint8 underlyingDecimals);
    error AmountNotRepresentable(uint256 amount, uint256 scale);
    error ZeroAmount();
    error FeeOnTransferNotSupported(uint256 expected, uint256 received);

    /// @param underlying Token to wrap. Must have MORE than 9 decimals; a token
    ///        with 9 or fewer is already representable on Mina and must go
    ///        through the bridge directly rather than be wrapped pointlessly.
    constructor(IERC20 underlying)
        ERC20(
            string.concat("Bridgeable ", IERC20Metadata(address(underlying)).name()),
            string.concat("b", IERC20Metadata(address(underlying)).symbol())
        )
    {
        uint8 d = IERC20Metadata(address(underlying)).decimals();
        if (d <= BRIDGE_DECIMALS) revert DecimalsTooLow(d);

        UNDERLYING = underlying;
        UNDERLYING_DECIMALS = d;
        SCALE = 10 ** (d - BRIDGE_DECIMALS);
    }

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return BRIDGE_DECIMALS;
    }

    /// @notice Largest wrappable amount at or below `amount`.
    /// @dev The frontend should call this and show the user the rounded figure,
    /// so {wrap} never reverts on them by surprise.
    function roundDown(uint256 amount) external view returns (uint256) {
        return amount - (amount % SCALE);
    }

    /// @notice Underlying dust that `amount` would leave behind.
    function dust(uint256 amount) external view returns (uint256) {
        return amount % SCALE;
    }

    /// @notice Wrap `amount` underlying base units into 9-decimal tokens.
    ///
    /// @dev Reverts unless `amount` is an exact multiple of {SCALE}. This is the
    /// whole point of the contract: refusing is the only behaviour that cannot
    /// silently lose the user's dust. Use {roundDown} to compute a valid amount.
    function wrap(uint256 amount) external nonReentrant returns (uint256 minted) {
        if (amount == 0) revert ZeroAmount();
        if (amount % SCALE != 0) revert AmountNotRepresentable(amount, SCALE);

        // Measure the actual delta: a fee-on-transfer token would otherwise let
        // the contract mint against value it never received.
        uint256 before = UNDERLYING.balanceOf(address(this));
        UNDERLYING.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = UNDERLYING.balanceOf(address(this)) - before;
        if (received != amount) revert FeeOnTransferNotSupported(amount, received);

        minted = amount / SCALE;
        _mint(msg.sender, minted);
    }

    /// @notice Burn `amount` wrapper units and return the underlying.
    function unwrap(uint256 amount) external nonReentrant returns (uint256 returned) {
        if (amount == 0) revert ZeroAmount();

        _burn(msg.sender, amount);
        returned = amount * SCALE;
        UNDERLYING.safeTransfer(msg.sender, returned);
    }

    /// @notice True while every wrapper token is backed by escrowed underlying.
    /// @dev `>=` rather than `==` because a donation of underlying tokens to
    /// this contract is possible and harmless; it can never make the wrapper
    /// under-backed, which is the property that matters.
    function fullyBacked() external view returns (bool) {
        return UNDERLYING.balanceOf(address(this)) >= totalSupply() * SCALE;
    }
}

/// @title BridgeWrapperFactory
/// @notice One canonical wrapper per underlying token.
///
/// @dev CREATE2 keyed by the underlying address, so the wrapper for a token is
/// the same address for everyone and is computable before deployment. Competing
/// wrappers for the same asset would split liquidity, and a bridge that accepted
/// several of them would have to be told which is canonical.
contract BridgeWrapperFactory {
    event WrapperDeployed(address indexed underlying, address indexed wrapper);

    error AlreadyDeployed(address wrapper);

    /// @notice Address of the wrapper for `underlying`, deployed or not.
    function wrapperFor(IERC20 underlying) public view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                bytes32(uint256(uint160(address(underlying)))),
                keccak256(
                    abi.encodePacked(type(BridgeWrapper).creationCode, abi.encode(underlying))
                )
            )
        );
        return address(uint160(uint256(hash)));
    }

    function isDeployed(IERC20 underlying) external view returns (bool) {
        return wrapperFor(underlying).code.length > 0;
    }

    /// @notice Deploy the canonical wrapper for `underlying`. Permissionless.
    function deploy(IERC20 underlying) external returns (BridgeWrapper wrapper) {
        address predicted = wrapperFor(underlying);
        if (predicted.code.length > 0) revert AlreadyDeployed(predicted);

        wrapper = new BridgeWrapper{salt: bytes32(uint256(uint160(address(underlying))))}(underlying);
        emit WrapperDeployed(address(underlying), address(wrapper));
    }
}
