// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {PoseidonPallas} from "./libraries/PoseidonPallas.sol";

/// @title TransferChain
/// @notice The single Poseidon chain every Flare -> Mina transfer folds into.
///
/// @dev One chain, one event, one emitter — and that is the whole point.
///
/// Each asset used to keep its own chain, so a cycle cost one FDC attestation
/// and one full proving pass *per asset that moved*: request, wait for the
/// round, hash 1344 bytes in-circuit, climb a Merkle path. Four assets meant
/// four of those, and with real traffic the relayer never catches up.
///
/// Folded here instead, a single attestation covers every transfer since the
/// last one, whatever the asset. The Mina circuits get simpler too: one emitter
/// address and one event signature to pin, rather than one pair per rail.
///
/// **What it does not do.** It holds no funds, mints nothing, and cannot be
/// called by anyone but the bridges it was told about. Its only power is to
/// decide what the chain says happened — which is exactly what the Mina side
/// verifies against the FDC, so a lie here is caught there.
contract TransferChain is Ownable2Step {
    /// @notice Head of the chain. Zero is the empty chain, on both sides.
    uint256 public head;

    /// @notice Position of the next record. Monotonic across every asset, so an
    /// index names one transfer and the Mina side needs no per-token counter.
    uint256 public nextIndex;

    /// @notice Which contract may record which asset.
    ///
    /// @dev Per token, not per contract. A caller allowed to append *anything*
    /// could forge a transfer for an asset it does not custody — a compromised
    /// vault writing an FMINA record would drain the escrow, since the Mina side
    /// verifies the chain faithfully and the chain would be saying it happened.
    /// The escrow may only record FMINA; the vault only the tokens it accepts.
    mapping(address => mapping(address => bool)) public mayAppend;

    /// @dev Domain separator, matching `TRANSFER_PREFIX` in the Mina circuit.
    /// "MinaPortTransferV1" read as little-endian bytes, o1js `prefixToField`.
    uint256 internal constant TRANSFER_PREFIX_FIELD =
        4297918352702906165387926136531478503123277;

    /// @notice The canonical record. Field order is protocol: it mirrors the
    /// fold below and the `TransferRecord` the Mina side replays.
    ///
    /// @dev Three indexed arguments and four words of data, deliberately. The
    /// Mina circuit takes a fixed-size attestation response, so an event one
    /// word narrower simply does not fit the type.
    event Transfer(
        uint256 indexed index,
        address indexed token,
        address indexed sender,
        bytes32 minaRecipient,
        uint256 amount,
        uint256 previousHead,
        uint256 newHead
    );

    event AppenderSet(address indexed appender, address indexed token, bool allowed);

    error NotAnAppender(address caller, address token);
    error ZeroAddress();
    error AmountExceedsUint64();

    constructor(address owner_) Ownable(owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
    }

    /// @notice Allow `appender` to record transfers of `token`, or stop it.
    function setAppender(address appender, address token, bool allowed) external onlyOwner {
        if (appender == address(0) || token == address(0)) revert ZeroAddress();
        mayAppend[appender][token] = allowed;
        emit AppenderSet(appender, token, allowed);
    }

    /// @notice Fold one transfer into the chain.
    ///
    /// @param token The asset. FMINA for the escrow rail, the locked token for
    ///        the vault. Carried in the record so a Mina port can tell which
    ///        entries are its own and prove it skipped only the others.
    /// @param recipientX Mina recipient's x coordinate.
    /// @param recipientIsOdd Its parity bit.
    ///
    /// @dev The caller has already moved the funds. This only records, so a
    /// revert here leaves nothing half-done — but it must be the last thing a
    /// caller does, or a reverting transfer would leave a claimable record.
    function append(
        address token,
        address sender,
        bytes32 minaRecipient,
        uint256 recipientX,
        bool recipientIsOdd,
        uint256 amount
    ) external returns (uint256 index, uint256 newHead) {
        if (!mayAppend[msg.sender][token]) revert NotAnAppender(msg.sender, token);
        // Mina accounts in `UInt64`. A larger amount would be recorded here and
        // unrepresentable there.
        if (amount > type(uint64).max) revert AmountExceedsUint64();

        index = nextIndex;
        nextIndex = index + 1;

        uint256 previousHead = head;
        uint256[] memory fields = new uint256[](6);
        fields[0] = previousHead;
        fields[1] = index;
        fields[2] = uint256(uint160(token));
        fields[3] = recipientX;
        fields[4] = recipientIsOdd ? 1 : 0;
        fields[5] = amount;

        newHead = PoseidonPallas.hashWithPrefix(TRANSFER_PREFIX_FIELD, fields);
        head = newHead;

        emit Transfer(index, token, sender, minaRecipient, amount, previousHead, newHead);
    }
}
