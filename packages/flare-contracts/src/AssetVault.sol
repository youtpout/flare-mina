// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from
    "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
// Not `ReentrancyGuardUpgradeable`: OZ 5.7 removed it and its CHANGELOG names
// this import as the migration. The flag lives in an ERC-7201 slot, so it needs
// no initialiser and an uninitialised slot reads as "not entered".
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {MinaAddressLib} from "./libraries/MinaAddress.sol";
import {PoseidonPallas} from "./libraries/PoseidonPallas.sol";
import {BridgeWrapper} from "./BridgeWrapper.sol";

interface IWNat {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @title AssetVault
/// @notice Locks Flare assets so they can be minted as fungible tokens on Mina.
///
/// @dev This is the direction the product exists for. Mina has assets but little
/// DeFi; Flare has FXRP, USD₮0 and a working ecosystem. Moving that liquidity
/// onto Mina is what this contract starts.
///
/// **Why it is not part of `MinaPortBridge`.** That contract holds FMINA's mint
/// authority and touches exactly one token, which it deployed itself. The moment
/// a contract calls `transferFrom` on an arbitrary ERC-20 it accepts untrusted
/// code — fee-on-transfer, rebasing, reentrant callbacks. Keeping that away from
/// an unbounded mint authority is the whole reason for a separate address.
///
/// **The Poseidon lock chain, one per token.** Every lock folds its record into
/// `lockActionStateOf[token]`, exactly as `burnToMina` folds withdrawals. Mina
/// replays the chain in a ZkProgram and mints against a state the Flare
/// validator set has signed, so no attestor sits between the lock and the mint.
/// Per token rather than global so each wrapped asset advances independently and
/// its Mina port never has to replay links belonging to another asset.
///
/// **The invariant**, per token: `balanceOf(token) >= lockedOf(token)`, and
/// `lockedOf(token)` equals the supply minted on Mina once every claim has
/// settled. Greater-than-or-equal because anyone can donate tokens here, and a
/// donation must never make the invariant look broken.
contract AssetVault is Ownable2StepUpgradeable, PausableUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Amount locked per token, in the token's own base units.
    /// @dev Decimals are never converted. Tokens Mina's `UInt64` cannot
    /// represent must cross through `BridgeWrapper` first.
    mapping(address => uint256) public lockedOf;

    /// @notice Next claim id, per token. It is the position in that token's
    /// chain, so the Mina side derives it by counting links rather than trusting
    /// a number.
    mapping(address => uint256) public nextClaimIdOf;

    /// @notice Tokens this vault accepts.
    /// @dev An allowlist, unlike the swap path, which is deliberately open. A
    /// swap risks only the caller; a lock here mints on Mina, so an unvetted
    /// token would be a supply bug rather than a bad trade.
    mapping(address => bool) public accepted;

    /// @notice Head of each token's Poseidon lock chain. The value Mina proves
    /// against; it starts at zero and only ever moves forward.
    mapping(address => uint256) public lockActionStateOf;

    /// @notice Claim ids already released back to Flare, per token.
    mapping(address => mapping(uint256 => bool)) public releasedClaims;

    /// @notice Wrapped native token (WC2FLR), and the 9-decimal wrapper Mina can
    /// actually hold. Native locks route through both; see {lockNative}.
    IWNat public WNAT;
    BridgeWrapper public NATIVE_WRAPPER;

    /// @dev Domain separator, matching `LOCK_PREFIX` in the Mina LockChain.
    /// "MinaPortLockV1" read as little-endian bytes, o1js `prefixToField`.
    uint256 internal constant LOCK_PREFIX_FIELD = 1000684927660458632616681252219213;

    /// @dev Reserved so future versions can add state behind the proxy.
    uint256[44] private __gap;

    /// @notice The canonical lock. Field order is protocol: it mirrors the fold
    /// below and the `LockRecord` the Mina side replays.
    event AssetLocked(
        uint256 indexed claimId,
        address indexed token,
        address indexed sender,
        bytes32 minaRecipient,
        uint256 amount,
        uint256 previousActionState,
        uint256 newActionState
    );

    event AssetReleased(
        uint256 indexed claimId, address indexed token, address indexed recipient, uint256 amount
    );
    event TokenAccepted(address indexed token, bool accepted);
    event NativeRouteSet(address wnat, address wrapper);

    error ZeroAmount();
    error ZeroAddress();
    error TokenNotAccepted(address token);
    error NothingReceived();
    error InsufficientLocked(address token, uint256 locked, uint256 requested);
    error AmountExceedsUint64();
    error ClaimAlreadyReleased(address token, uint256 claimId);
    error NativeRouteNotSet();
    error NativeTransferFailed();

    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __Pausable_init();
    }

    /// @notice Point native locks at WC2FLR and its 9-decimal wrapper.
    function setNativeRoute(IWNat wnat, BridgeWrapper wrapper) external onlyOwner {
        if (address(wnat) == address(0) || address(wrapper) == address(0)) revert ZeroAddress();
        WNAT = wnat;
        NATIVE_WRAPPER = wrapper;
        emit NativeRouteSet(address(wnat), address(wrapper));
    }

    /// @notice Accept or refuse a token.
    function setAccepted(address token, bool value) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        accepted[token] = value;
        emit TokenAccepted(token, value);
    }

    /// @notice Lock `amount` of `token` and name the Mina account entitled to it.
    /// @param minaRecipient Mina account, packed as `x | isOdd << 255`.
    function lock(address token, uint256 amount, bytes32 minaRecipient)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 claimId)
    {
        if (amount == 0) revert ZeroAmount();
        if (!accepted[token]) revert TokenNotAccepted(token);

        // Measured, not declared: a fee-on-transfer token delivers less than it
        // was asked for, and crediting the requested figure would mint more on
        // Mina than is held here — unbacked supply from an ordinary token.
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;

        claimId = _record(token, received, minaRecipient, msg.sender);
    }

    /// @notice Lock native C2FLR: wrap to WC2FLR, then down to 9 decimals.
    /// @dev At 18 decimals a `UInt64` caps out at 18 whole tokens, so the native
    /// asset can only cross as its wrapper. Dust below 1 gwei is refused rather
    /// than silently dropped, and the wrapper token is what gets locked.
    function lockNative(bytes32 minaRecipient)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 claimId)
    {
        if (msg.value == 0) revert ZeroAmount();
        BridgeWrapper wrapper = NATIVE_WRAPPER;
        if (address(wrapper) == address(0)) revert NativeRouteNotSet();
        if (!accepted[address(wrapper)]) revert TokenNotAccepted(address(wrapper));

        WNAT.deposit{value: msg.value}();
        IERC20(address(WNAT)).forceApprove(address(wrapper), msg.value);

        uint256 before = wrapper.balanceOf(address(this));
        wrapper.wrap(msg.value);
        uint256 minted = wrapper.balanceOf(address(this)) - before;

        claimId = _record(address(wrapper), minted, minaRecipient, msg.sender);
    }

    /// @dev The shared tail of both lock paths: validate, fold into the chain,
    /// emit. The recipient is checked as a Pallas field element here because a
    /// malformed key names no Mina account, so accepting it would lock funds
    /// against a mint nobody can claim.
    function _record(address token, uint256 received, bytes32 minaRecipient, address sender)
        internal
        returns (uint256 claimId)
    {
        if (received == 0) revert NothingReceived();
        if (received > type(uint64).max) revert AmountExceedsUint64();
        (uint256 recipientX, bool recipientIsOdd) =
            MinaAddressLib.unpack(MinaAddressLib.fromBytes32(minaRecipient));

        claimId = nextClaimIdOf[token];
        nextClaimIdOf[token] = claimId + 1;
        lockedOf[token] += received;

        uint256 previousActionState = lockActionStateOf[token];
        uint256[] memory fields = new uint256[](5);
        fields[0] = previousActionState;
        fields[1] = claimId;
        fields[2] = recipientX;
        fields[3] = recipientIsOdd ? 1 : 0;
        fields[4] = received;
        uint256 newActionState = PoseidonPallas.hashWithPrefix(LOCK_PREFIX_FIELD, fields);
        lockActionStateOf[token] = newActionState;

        emit AssetLocked(
            claimId, token, sender, minaRecipient, received, previousActionState, newActionState
        );
    }

    /// @notice Release tokens whose Mina-side wrapper has been burned.
    ///
    /// @dev HACKATHON TRUST ASSUMPTION, the same one as the attested deposit
    /// path: the owner acts on an attestation of the Mina burn rather than a
    /// proof of Mina state. It is the only privileged action here — the owner
    /// cannot mint, cannot lock for someone else, and cannot exceed `lockedOf`.
    function release(uint256 claimId, address token, address recipient, uint256 amount)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (releasedClaims[token][claimId]) revert ClaimAlreadyReleased(token, claimId);

        uint256 locked = lockedOf[token];
        if (locked < amount) revert InsufficientLocked(token, locked, amount);

        // Debit and mark before transferring: a token with a transfer hook must
        // never re-enter and see the old figures.
        releasedClaims[token][claimId] = true;
        lockedOf[token] = locked - amount;
        IERC20(token).safeTransfer(recipient, amount);

        emit AssetReleased(claimId, token, recipient, amount);
    }

    /// @notice Release a native lock: unwrap back through WC2FLR to C2FLR.
    function releaseNative(uint256 claimId, address payable recipient, uint256 amount)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        BridgeWrapper wrapper = NATIVE_WRAPPER;
        if (address(wrapper) == address(0)) revert NativeRouteNotSet();
        address token = address(wrapper);
        if (releasedClaims[token][claimId]) revert ClaimAlreadyReleased(token, claimId);

        uint256 locked = lockedOf[token];
        if (locked < amount) revert InsufficientLocked(token, locked, amount);

        releasedClaims[token][claimId] = true;
        lockedOf[token] = locked - amount;

        uint256 underlying = wrapper.unwrap(amount);
        WNAT.withdraw(underlying);
        (bool ok,) = recipient.call{value: underlying}("");
        if (!ok) revert NativeTransferFailed();

        emit AssetReleased(claimId, token, recipient, amount);
    }

    /// @notice True when the vault holds at least what it says is locked.
    function isSolvent(address token) external view returns (bool) {
        return IERC20(token).balanceOf(address(this)) >= lockedOf[token];
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Only WNat may push native in, when {releaseNative} unwraps.
    receive() external payable {
        if (msg.sender != address(WNAT)) revert NativeTransferFailed();
    }
}
