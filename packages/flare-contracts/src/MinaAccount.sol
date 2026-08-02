// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MinaAuthRegistry} from "./MinaAuthRegistry.sol";
import {MinaSchnorr} from "./libraries/MinaSchnorr.sol";
import {MinaAddressLib} from "./libraries/MinaAddress.sol";

/// @title MinaAccount
/// @notice A Flare account owned by a Mina key.
///
/// @dev This is the piece that makes "a Mina wallet holds and trades assets on
/// Flare" literally true. The account is a contract, not an EOA — it has to be,
/// because a Pallas key cannot produce the ECDSA signature an EVM transaction
/// requires. It holds tokens, and it executes arbitrary calls when presented
/// with a Schnorr signature from the one Mina key that owns it.
///
/// **Who sends the transaction.** Anyone. The signature is the authorisation
/// and the submitter cannot alter the target, the value, or the calldata — all
/// three are committed to by `actionHash` inside the signed message. A submitter
/// can only decline to submit, and one honest submitter is enough. There is
/// therefore no privileged relayer to trust.
///
/// **What the owner still needs.** Someone must pay gas. Today that is whoever
/// sends the transaction. Reimbursing the submitter out of the account's own
/// FMINA balance — which would remove the last reason to hold an EVM account —
/// is the natural next step and is deliberately not in this version.
contract MinaAccount {
    /// @notice The Mina key that owns this account, packed as `x | isOdd << 255`.
    bytes32 public immutable MINA_KEY;

    /// @notice Registry performing signature verification and nonce accounting.
    MinaAccountRegistryRef public immutable REGISTRY;

    event Executed(address indexed target, uint256 value, bytes32 indexed actionHash);
    event Received(address indexed from, uint256 value);

    error WrongOwner(bytes32 expected, bytes32 actual);
    error CallFailed(bytes returnData);

    constructor(bytes32 minaKey, address registry) {
        MINA_KEY = minaKey;
        REGISTRY = MinaAccountRegistryRef(registry);
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /// @notice Commitment to a call. This is what the Mina key actually signs.
    ///
    /// @dev `data` is hashed rather than embedded so the commitment is a fixed
    /// 32 bytes regardless of calldata size. `abi.encode` rather than
    /// `encodePacked`: with packed encoding a target/value/data-hash triple
    /// could be re-split into a different one.
    function actionHash(address target, uint256 value, bytes memory data)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(target, value, keccak256(data)));
    }

    /// @notice Execute a call authorised by this account's Mina key.
    ///
    /// @param publicKey The owning Mina key, with its `y` coordinate. Checked
    ///        against {MINA_KEY}, so a signature from some other valid Mina key
    ///        cannot drive this account.
    /// @param nonce Sequential per Mina key; consumed by the registry.
    /// @param expiry Unix seconds after which the authorization is void.
    ///
    /// @dev The nonce is consumed inside `REGISTRY.consume`, which runs before
    /// the external call. A reentrant call therefore cannot replay the same
    /// authorization — the nonce has already advanced.
    function execute(
        MinaSchnorr.PublicKey calldata publicKey,
        MinaSchnorr.Signature calldata signature,
        uint64 nonce,
        uint64 expiry,
        address target,
        uint256 value,
        bytes calldata data
    ) external returns (bytes memory) {
        bytes32 owner =
            bytes32(MinaAddressLib.raw(MinaAddressLib.pack(publicKey.x, publicKey.isOdd)));
        if (owner != MINA_KEY) revert WrongOwner(MINA_KEY, owner);

        bytes32 action = actionHash(target, value, data);

        // Verifies the signature and consumes the nonce. `target` in the
        // authorization is this account, so an authorization for one account
        // cannot be consumed by another.
        REGISTRY.consume(
            publicKey,
            signature,
            MinaAuthRegistry.Authorization({
                chainId: block.chainid,
                target: address(this),
                actionHash: action,
                nonce: nonce,
                expiry: expiry
            }),
            false
        );

        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);

        emit Executed(target, value, action);
        return ret;
    }
}

/// @dev Minimal view of the registry, declared separately so `MinaAccount` does
/// not have to import the full contract for one external call.
interface MinaAccountRegistryRef {
    function consume(
        MinaSchnorr.PublicKey calldata publicKey,
        MinaSchnorr.Signature calldata signature,
        MinaAuthRegistry.Authorization calldata auth,
        bool mainnet
    ) external returns (bytes32);

    function nextNonce(bytes32 minaKey) external view returns (uint64);
}

/// @title MinaAccountFactory
/// @notice Deploys `MinaAccount`s at an address derived from the Mina key.
///
/// @dev CREATE2 with the Mina key as salt, so every Mina key already has a
/// Flare address before anything is deployed. The frontend can show it, and the
/// bridge can mint to it, without a transaction having happened — deployment
/// becomes a detail that can wait until the first outgoing call.
contract MinaAccountFactory {
    /// @notice Registry every account created here will use.
    address public immutable REGISTRY;

    event AccountDeployed(bytes32 indexed minaKey, address indexed account);

    constructor(address registry) {
        REGISTRY = registry;
    }

    /// @notice Address of the account for `minaKey`, deployed or not.
    function accountOf(bytes32 minaKey) public view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                minaKey,
                keccak256(
                    abi.encodePacked(type(MinaAccount).creationCode, abi.encode(minaKey, REGISTRY))
                )
            )
        );
        return address(uint160(uint256(hash)));
    }

    /// @notice True when the account for `minaKey` has been deployed.
    function isDeployed(bytes32 minaKey) external view returns (bool) {
        return accountOf(minaKey).code.length > 0;
    }

    /// @notice Deploy the account for `minaKey`.
    /// @dev Permissionless and idempotent-by-address: the Mina key determines
    /// the address, so a third party deploying it first changes nothing.
    function deploy(bytes32 minaKey) external returns (MinaAccount account) {
        if (!MinaAddressLib.isValid(minaKey)) revert MinaAddressLib.InvalidMinaField();

        account = new MinaAccount{salt: minaKey}(minaKey, REGISTRY);
        emit AccountDeployed(minaKey, address(account));
    }
}
