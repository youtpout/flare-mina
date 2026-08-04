// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {MinaAddressLib} from "./libraries/MinaAddress.sol";

/// @title AssetVault
/// @notice Locks Flare assets so they can be minted as fungible tokens on Mina.
///
/// @dev This is the direction the product exists for. Mina has assets but
/// little DeFi; Flare has FXRP, USD₮0 and WETH and a working ecosystem. Moving
/// that liquidity onto Mina is what this contract starts.
///
/// **Why it is not part of `MinaPortBridge`.** That contract holds FMINA's mint
/// authority and touches exactly one token, which it deployed itself. The
/// moment a contract calls `transferFrom` on an arbitrary ERC-20 it accepts
/// untrusted code — fee-on-transfer, rebasing, non-standard returns, reentrant
/// callbacks. Keeping that away from an unbounded mint authority is the whole
/// reason for a separate address. It also lets FXRP be paused without freezing
/// the MINA rail, which is the product's core.
///
/// **The invariant**, per token rather than global:
/// `balanceOf(token) >= lockedOf(token)`, and `lockedOf(token)` equals the
/// supply minted on Mina once every claim has settled. Greater-than-or-equal
/// rather than equality because anyone can donate tokens to this address, and
/// a donation must never make the invariant look broken.
contract AssetVault is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Amount locked per token, in the token's own base units.
    /// @dev Decimals are never converted. `100000` base units is `0.1 USDT` on
    /// both chains, checkable by comparing two integers. Tokens Mina's `UInt64`
    /// cannot represent must cross through `BridgeWrapper` first.
    mapping(address => uint256) public lockedOf;

    /// @notice Next claim id. Monotonic across every token, so one id names one
    /// lock and the Mina side needs no per-token bookkeeping.
    uint256 public nextClaimId;

    /// @notice Tokens this vault accepts.
    /// @dev An allowlist, unlike the swap path, which is deliberately open. A
    /// swap risks only the caller; a lock here mints on Mina, so an unvetted
    /// token — one with a transfer hook, or 18 decimals Mina cannot hold —
    /// would be a supply bug rather than a bad trade.
    mapping(address => bool) public accepted;

    /// @notice The canonical lock. This is the event the Mina side proves
    /// against, so its signature and field order are protocol.
    event AssetLocked(
        uint256 indexed claimId,
        address indexed token,
        address indexed sender,
        bytes32 minaRecipient,
        uint256 amount
    );

    event AssetReleased(
        uint256 indexed claimId, address indexed token, address indexed recipient, uint256 amount
    );
    event TokenAccepted(address indexed token, bool accepted);

    error ZeroAmount();
    error ZeroAddress();
    error TokenNotAccepted(address token);
    error NothingReceived();
    error InsufficientLocked(address token, uint256 locked, uint256 requested);

    constructor(address owner_) Ownable(owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
    }

    /// @notice Accept or refuse a token.
    function setAccepted(address token, bool value) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        accepted[token] = value;
        emit TokenAccepted(token, value);
    }

    /// @notice Lock `amount` of `token` and name the Mina account entitled to it.
    ///
    /// @param minaRecipient Mina account, packed as `x | isOdd << 255`.
    ///
    /// @dev The credited amount is **measured, not declared**. A fee-on-transfer
    /// token delivers less than it was asked for, and crediting the requested
    /// figure would mint more on Mina than is actually held here — unbacked
    /// supply, created by an ordinary token rather than an attack.
    ///
    /// The recipient is validated as a Pallas field element here rather than on
    /// the Mina side: a malformed key corresponds to no Mina account, so
    /// accepting it would lock the user's tokens against an unclaimable mint.
    function lock(address token, uint256 amount, bytes32 minaRecipient)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 claimId)
    {
        if (amount == 0) revert ZeroAmount();
        if (!accepted[token]) revert TokenNotAccepted(token);
        MinaAddressLib.fromBytes32(minaRecipient);

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert NothingReceived();

        claimId = nextClaimId++;
        lockedOf[token] += received;

        emit AssetLocked(claimId, token, msg.sender, minaRecipient, received);
    }

    /// @notice Release tokens whose Mina-side wrapper has been burned.
    ///
    /// @dev HACKATHON TRUST ASSUMPTION, and the same one as everywhere else:
    /// the owner acts on an attestation of the burn rather than a proof of Mina
    /// state. It is deliberately the only privileged action here — the owner
    /// cannot mint, cannot lock on someone's behalf, and cannot release more
    /// than is locked.
    function release(uint256 claimId, address token, address recipient, uint256 amount)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 locked = lockedOf[token];
        if (locked < amount) revert InsufficientLocked(token, locked, amount);

        // Debit before transferring: a token with a transfer hook must never
        // re-enter and see the old figure. `nonReentrant` covers it too, and
        // both is the right amount of paranoia for a contract holding value.
        lockedOf[token] = locked - amount;
        IERC20(token).safeTransfer(recipient, amount);

        emit AssetReleased(claimId, token, recipient, amount);
    }

    /// @notice True when the vault holds at least what it says is locked.
    /// @dev Asserted in the test suite after every state-changing operation.
    function isSolvent(address token) external view returns (bool) {
        return IERC20(token).balanceOf(address(this)) >= lockedOf[token];
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
