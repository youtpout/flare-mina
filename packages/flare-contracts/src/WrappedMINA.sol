// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title WrappedMINA
/// @notice ERC-20 representation of native MINA escrowed by the Mina bridge zkApp.
///
/// @dev **Decimals are 9, not 18.** MINA's base unit is the nanomina (1e-9 MINA)
/// and wMINA uses exactly the same base unit, so one nanomina locked on Mina is
/// one wMINA base unit minted here. The collateral invariant
/// `totalSupply() == escrowedNanomina` is then an integer equality that holds at
/// every block — no conversion, no rounding, no dust. Scaling to 18 decimals
/// would introduce a multiplication on every path and a truncation on the way
/// back; the 1:1 mapping is deliberately chosen to make the invariant auditable.
///
/// Minting and burning are restricted to the bridge, which is immutable. The
/// token therefore has no admin, no pause, and no upgrade path of its own: the
/// only contract that can change the supply is the one enforcing the collateral.
contract WrappedMINA is ERC20, ERC20Permit {
    /// @notice The only address allowed to mint and burn.
    address public immutable BRIDGE;

    error OnlyBridge();
    error ZeroAddress();

    modifier onlyBridge() {
        if (msg.sender != BRIDGE) revert OnlyBridge();
        _;
    }

    constructor(address bridge) ERC20("Wrapped MINA", "wMINA") ERC20Permit("Wrapped MINA") {
        if (bridge == address(0)) revert ZeroAddress();
        BRIDGE = bridge;
    }

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return 9;
    }

    /// @notice Mint wMINA against newly escrowed MINA. Bridge only.
    /// @dev Emits the standard `Transfer(address(0), to, amount)`.
    function mint(address to, uint256 amount) external onlyBridge {
        _mint(to, amount);
    }

    /// @notice Burn wMINA being withdrawn to Mina. Bridge only.
    /// @dev Burns from `from`'s balance. The bridge always calls this on
    /// `msg.sender` of `burnToMina`, so no allowance dance is required and no
    /// third party can burn another account's balance.
    /// Emits the standard `Transfer(from, address(0), amount)`.
    function burn(address from, uint256 amount) external onlyBridge {
        _burn(from, amount);
    }
}
