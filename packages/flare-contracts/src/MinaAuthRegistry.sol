// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MinaAddress, MinaAddressLib} from "./libraries/MinaAddress.sol";

/// @notice Minimal SP1 verifier gateway interface, declared inline so this
/// contract has no external dependency. Matches `ISP1Verifier` from
/// sp1-contracts and the interface used by `MinaKimchiVerifier`.
interface ISP1Verifier {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes)
        external
        view;
}

/// @notice One Mina-signed authorization, as committed by the `minaport-guest`
/// SP1 program.
/// @dev ABI-identical to `MinaAuthorization` in `minaport-core` (Rust). The
/// guest commits `abi.encode(MinaAuthorization[])`.
struct MinaAuthorization {
    /// @dev Mina public key packed as `x | isOdd << 255`.
    bytes32 minaPublicKey;
    /// @dev EVM chain the authorization is valid on.
    uint256 chainId;
    /// @dev Contract the authorization is addressed to.
    address target;
    /// @dev Opaque commitment to the authorised action.
    bytes32 actionHash;
    /// @dev Per-key anti-replay nonce.
    uint64 nonce;
    /// @dev Unix seconds after which the authorization is void.
    uint64 expiry;
}

/// @title MinaAuthRegistry
/// @notice Turns a Mina Schnorr signature into an on-chain authorization on Flare.
///
/// @dev A Mina key is a Pallas key: it cannot produce an ECDSA signature and can
/// therefore never control an EOA on an EVM chain. This contract is the bridge
/// across that gap. An SP1 program verifies the Schnorr signature off-chain and
/// commits the authorization; this contract verifies the resulting Groth16 proof
/// and records the authorization as consumed.
///
/// **What the proof does and does not say.** The proof attests only that the
/// Mina key signed the authorization. It says nothing about whether the action
/// is currently appropriate. Chain binding, target binding, expiry and nonce are
/// enforced *here*, not in the circuit, because they are properties of the
/// current chain state rather than of the signature.
///
/// **Batching.** The guest verifies N authorizations per proof. The dominant
/// cost of an SP1 proof is the fixed Groth16 wrap, not execution, so batching is
/// what makes per-user authorization economical. `submit` therefore takes an
/// array and each entry is settled independently.
contract MinaAuthRegistry {
    using MinaAddressLib for MinaAddress;

    /// @notice SP1 verifier gateway.
    address public immutable SP1_GATEWAY;

    /// @notice Verification key of the `minaport-guest` program.
    /// @dev Immutable: rotating it would let a different program mint
    /// authorizations. A new guest means a new deployment, which is a visible,
    /// auditable event rather than a silent storage write.
    bytes32 public immutable PROGRAM_VKEY;

    /// @notice Next expected nonce per Mina key.
    /// @dev Strictly sequential rather than a bitmap: it makes replay impossible
    /// with one storage slot, and makes the expected next nonce readable by the
    /// frontend without an archive query.
    mapping(bytes32 => uint64) public nextNonce;

    event AuthorizationConsumed(
        bytes32 indexed minaPublicKey,
        address indexed target,
        bytes32 indexed actionHash,
        uint64 nonce
    );

    error EmptyBatch();
    error WrongChain(uint256 expected, uint256 actual);
    error WrongTarget(address expected, address actual);
    error Expired(uint64 expiry);
    error UnexpectedNonce(bytes32 minaPublicKey, uint64 expected, uint64 actual);
    error InvalidMinaKey(bytes32 minaPublicKey);

    constructor(address gateway, bytes32 programVkey) {
        SP1_GATEWAY = gateway;
        PROGRAM_VKEY = programVkey;
    }

    /// @notice Verify a batch of Mina-signed authorizations and consume the ones
    /// addressed to `msg.sender`.
    ///
    /// @dev Called by the contract that wants to act on the authorization, so
    /// `target` is checked against `msg.sender`. That is what prevents an
    /// authorization intended for one contract from being replayed at another:
    /// the signer names its target, and only that target can consume it.
    ///
    /// Entries in the batch that are not addressed to `msg.sender` are skipped
    /// rather than reverting, so one proof can carry authorizations for several
    /// contracts and each settles independently.
    ///
    /// @return consumed The authorizations that were addressed to `msg.sender`
    /// and passed every check.
    function consume(
        bytes calldata publicValues,
        bytes calldata sp1Proof
    ) external returns (MinaAuthorization[] memory consumed) {
        // Reverts unless the proof attests to exactly these public values.
        ISP1Verifier(SP1_GATEWAY).verifyProof(PROGRAM_VKEY, publicValues, sp1Proof);

        MinaAuthorization[] memory batch = abi.decode(publicValues, (MinaAuthorization[]));
        if (batch.length == 0) revert EmptyBatch();

        consumed = new MinaAuthorization[](batch.length);
        uint256 count;

        for (uint256 i; i < batch.length; ++i) {
            MinaAuthorization memory auth = batch[i];
            if (auth.target != msg.sender) continue;

            if (auth.chainId != block.chainid) revert WrongChain(block.chainid, auth.chainId);
            if (auth.expiry < block.timestamp) revert Expired(auth.expiry);
            if (!MinaAddressLib.isValid(auth.minaPublicKey)) {
                revert InvalidMinaKey(auth.minaPublicKey);
            }

            uint64 expected = nextNonce[auth.minaPublicKey];
            if (auth.nonce != expected) {
                revert UnexpectedNonce(auth.minaPublicKey, expected, auth.nonce);
            }
            nextNonce[auth.minaPublicKey] = expected + 1;

            emit AuthorizationConsumed(
                auth.minaPublicKey, auth.target, auth.actionHash, auth.nonce
            );

            consumed[count++] = auth;
        }

        // Shrink to the number actually consumed.
        assembly {
            mstore(consumed, count)
        }
    }
}
