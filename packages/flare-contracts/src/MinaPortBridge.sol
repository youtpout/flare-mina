// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {FMINA} from "./FMINA.sol";
import {MinaAddressLib} from "./libraries/MinaAddress.sol";
import {MinaSchnorr} from "./libraries/MinaSchnorr.sol";
import {SignaturePurpose} from "./libraries/SignaturePurpose.sol";
import {MinaPortEncoding} from "./libraries/MinaPortEncoding.sol";
import {IMinaSettlementVerifier, SettlementPublicValues} from "./interfaces/IMinaSettlementVerifier.sol";

/// @title MinaPortBridge
/// @notice Flare side of the MINA <-> FMINA bridge.
///
/// @dev Two independent flows:
///
/// **Mina -> Flare.** A relayer submits a proof that the Mina bridge zkApp
/// advanced its action state by a batch of deposits, committing a Merkle root
/// over those deposits. The bridge records the root; recipients then claim
/// individually with a Merkle proof, which mints FMINA. Splitting settlement
/// from claiming keeps the relayer off the critical path for user funds: once a
/// root is accepted, the relayer can disappear and every recipient can still
/// claim permissionlessly.
///
/// **Flare -> Mina.** A holder burns FMINA and the bridge emits a canonical
/// `WithdrawToMina` event carrying a monotonic nonce. The Mina side releases the
/// escrow against a proof of that event.
///
/// Collateral invariant: `totalSupply(FMINA) == escrowedNanomina`, and both only
/// change inside `claimDeposit` (up) and `burnToMina` (down).
contract MinaPortBridge is Ownable2Step, Pausable, ReentrancyGuard {
    using MinaPortEncoding for MinaPortEncoding.Deposit;

    // -------------------------------------------------------------------------
    // Immutables
    // -------------------------------------------------------------------------

    /// @notice The FMINA token. Deployed by this contract so the mint/burn
    /// authority can never be pointed at a token the bridge does not control.
    FMINA public immutable TOKEN;

    /// @notice Binds this bridge to one Mina zkApp on one Mina network.
    /// @dev Every accepted batch must carry this exact id, so a proof produced
    /// for a devnet deployment can never settle on a mainnet bridge.
    bytes32 public immutable BRIDGE_ID;

    /// @notice Delay enforced on verifier rotation.
    uint256 public constant VERIFIER_UPDATE_DELAY = 2 days;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice Verifier for settlement proofs.
    IMinaSettlementVerifier public verifier;

    /// @notice Pending verifier rotation, executable after `verifierUpdateReadyAt`.
    IMinaSettlementVerifier public pendingVerifier;
    uint256 public verifierUpdateReadyAt;

    /// @notice Latest Mina action state this bridge has settled up to.
    bytes32 public currentMinaActionState;

    /// @notice Batch nonce of the most recently accepted batch.
    uint64 public lastBatchNonce;

    /// @notice Deposit roots accepted by a verified settlement proof.
    mapping(bytes32 => bool) public acceptedDepositRoots;

    /// @notice Deposit leaves already claimed. Keyed by leaf digest.
    mapping(bytes32 => bool) public claimedDeposits;

    /// @notice Withdrawal nonces already emitted.
    mapping(uint256 => bool) public processedWithdrawalNonces;

    /// @notice Next withdrawal nonce to assign.
    uint256 public nextWithdrawalNonce;

    /// @notice Nanomina currently escrowed on Mina against circulating FMINA.
    uint256 public escrowedNanomina;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event DepositBatchAccepted(
        uint64 indexed batchNonce,
        bytes32 indexed depositsRoot,
        bytes32 previousActionState,
        bytes32 newActionState
    );

    event DepositClaimed(
        bytes32 indexed leaf,
        address indexed recipient,
        uint64 indexed nonce,
        uint64 amountNanomina
    );

    /// @notice Canonical withdrawal event. This is the event the Mina side
    /// proves against, so its signature and field order are protocol.
    event WithdrawToMina(
        uint256 indexed nonce,
        address indexed sender,
        bytes32 indexed minaRecipient,
        uint256 amount
    );

    event VerifierUpdateProposed(address indexed newVerifier, uint256 readyAt);
    event VerifierUpdateCancelled(address indexed cancelledVerifier);
    event VerifierUpdated(address indexed oldVerifier, address indexed newVerifier);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error Expired(uint64 expiry, uint256 nowSeconds);
    error AmountExceedsUint64();
    error InvalidProof();
    error UnexpectedBridgeId(bytes32 expected, bytes32 actual);
    error UnexpectedActionState(bytes32 expected, bytes32 actual);
    error NonMonotonicBatchNonce(uint64 last, uint64 submitted);
    error DepositRootAlreadyAccepted(bytes32 root);
    error DepositRootNotAccepted(bytes32 root);
    error DepositAlreadyClaimed(bytes32 leaf);
    error InvalidMerkleProof();
    error WithdrawalNonceAlreadyUsed(uint256 nonce);
    error NoPendingVerifier();
    error VerifierUpdateNotReady(uint256 readyAt);

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    /// @param owner_ Initial owner (two-step transferable).
    /// @param verifier_ Settlement verifier. May be a mock during development.
    /// @param bridgeId_ Identifier of the Mina zkApp + network this bridge serves.
    /// @param genesisActionState Mina action state the bridge starts from,
    ///        i.e. the zkApp's `Reducer.initialActionState` at deployment.
    constructor(
        address owner_,
        IMinaSettlementVerifier verifier_,
        bytes32 bridgeId_,
        bytes32 genesisActionState
    ) Ownable(owner_) {
        if (owner_ == address(0) || address(verifier_) == address(0)) revert ZeroAddress();
        verifier = verifier_;
        BRIDGE_ID = bridgeId_;
        currentMinaActionState = genesisActionState;
        TOKEN = new FMINA(address(this));
    }

    // -------------------------------------------------------------------------
    // Mina -> Flare
    // -------------------------------------------------------------------------

    /// @notice Accept a batch of Mina deposits proven by a settlement proof.
    /// @dev Permissionless: the proof is the authorisation, so anyone may pay
    /// the gas to advance the bridge. A censoring relayer can therefore be
    /// routed around by any party holding a valid proof.
    function submitDepositBatch(
        bytes calldata proofBytes,
        bytes calldata publicValuesBytes
    ) external whenNotPaused {
        // Reverts if the proof does not attest to these exact public values.
        verifier.verifySettlement(publicValuesBytes, proofBytes);

        SettlementPublicValues memory pv =
            abi.decode(publicValuesBytes, (SettlementPublicValues));

        if (!pv.proofValid) revert InvalidProof();
        if (pv.bridgeId != BRIDGE_ID) revert UnexpectedBridgeId(BRIDGE_ID, pv.bridgeId);
        if (pv.previousActionState != currentMinaActionState) {
            revert UnexpectedActionState(currentMinaActionState, pv.previousActionState);
        }
        // Strictly monotonic: replaying an old batch, or skipping one, is rejected.
        if (pv.batchNonce != lastBatchNonce + 1) {
            revert NonMonotonicBatchNonce(lastBatchNonce, pv.batchNonce);
        }
        if (acceptedDepositRoots[pv.depositsRoot]) {
            revert DepositRootAlreadyAccepted(pv.depositsRoot);
        }

        currentMinaActionState = pv.newActionState;
        lastBatchNonce = pv.batchNonce;
        acceptedDepositRoots[pv.depositsRoot] = true;

        emit DepositBatchAccepted(
            pv.batchNonce, pv.depositsRoot, pv.previousActionState, pv.newActionState
        );
    }

    /// @notice Claim a deposit from an accepted batch, minting FMINA.
    ///
    /// @dev Permissionless by design: the minted tokens always go to
    /// `deposit.recipientFlare`, which is bound inside the leaf and therefore
    /// inside the proof. Letting a third party pay the gas is strictly a UX win
    /// with no security cost — there is no `msg.sender` check because there is
    /// nothing `msg.sender` could influence.
    function claimDeposit(
        MinaPortEncoding.Deposit calldata deposit,
        bytes32 depositsRoot,
        bytes32[] calldata merkleProof
    ) external whenNotPaused nonReentrant {
        if (!acceptedDepositRoots[depositsRoot]) revert DepositRootNotAccepted(depositsRoot);
        if (deposit.amountNanomina == 0) revert ZeroAmount();
        if (deposit.recipientFlare == address(0)) revert ZeroAddress();

        bytes32 leaf = MinaPortEncoding.hashDepositLeaf(deposit);
        if (claimedDeposits[leaf]) revert DepositAlreadyClaimed(leaf);
        if (!MerkleProof.verify(merkleProof, depositsRoot, leaf)) revert InvalidMerkleProof();

        claimedDeposits[leaf] = true;
        escrowedNanomina += deposit.amountNanomina;

        emit DepositClaimed(leaf, deposit.recipientFlare, deposit.nonce, deposit.amountNanomina);

        TOKEN.mint(deposit.recipientFlare, deposit.amountNanomina);
    }

    // -------------------------------------------------------------------------
    // Mina -> Flare, signature path
    // -------------------------------------------------------------------------

    /// @notice Domain tag for a signed deposit intent.
    bytes32 public constant DEPOSIT_INTENT_DOMAIN = keccak256("FlareXMina.DepositIntent.v1");

    /// @notice Key attesting that a Mina-side escrow exists.
    /// @dev See {claimWithMinaSignature} for exactly what this key can and
    /// cannot do. Rotating it runs through the same timelock as the verifier.
    address public escrowAttestor;

    /// @notice Deposit intents already minted, keyed by their digest.
    mapping(bytes32 => bool) public consumedIntents;

    event EscrowAttestorUpdated(address indexed oldAttestor, address indexed newAttestor);
    event DepositMintedFromSignature(
        bytes32 indexed minaSender, address indexed recipient, uint64 nonce, uint64 amount
    );

    error IntentAlreadyConsumed(bytes32 intent);
    error InvalidMinaSignature();
    error InvalidAttestation();
    error AttestorNotSet();

    /// @notice Digest a Mina depositor signs to direct their escrow.
    ///
    /// @dev Returned as field elements because that is what Mina signs. The
    /// layout matches `MinaAuthRegistry.encodeAuthorization`, with the deposit
    /// domain and amount taking the place of a generic action.
    function depositIntentFields(
        address recipient,
        uint64 amountNanomina,
        uint64 nonce,
        uint64 expiry
    ) public view returns (uint256[] memory fields) {
        bytes32 action =
            keccak256(abi.encode(DEPOSIT_INTENT_DOMAIN, recipient, amountNanomina));

        // The purpose tag is first, so this can never collide with an account
        // authorization even though the remaining fields are laid out the same.
        fields = new uint256[](7);
        fields[0] = SignaturePurpose.DEPOSIT_INTENT;
        fields[1] = block.chainid;
        fields[2] = uint256(uint160(address(this)));
        fields[3] = uint256(uint128(bytes16(action)));
        fields[4] = uint256(uint128(uint256(action)));
        fields[5] = nonce;
        fields[6] = expiry;
    }

    /// @notice Mint FMINA against a Mina-side escrow, on two independent
    /// authorisations that neither party can supply alone.
    ///
    /// @dev **What each half buys.**
    ///
    /// The depositor's Schnorr signature binds the recipient and the amount.
    /// It is verified on-chain against the Pallas curve, so it rests on no
    /// third party. The attestor therefore cannot redirect a deposit, inflate
    /// it, or mint to itself — it can only agree or refuse.
    ///
    /// The attestor's signature asserts that the corresponding MINA is escrowed
    /// on Mina. **A signature cannot prove that**: it proves intent, not
    /// custody. Someone has to observe the Mina chain, and until the Mina-side
    /// state is proven on Flare that someone is trusted. This is the one trust
    /// assumption on this path and it is deliberately narrow — a dishonest
    /// attestor can mint unbacked supply, but cannot choose who receives it.
    ///
    /// Requiring both is strictly stronger than either. The depositor cannot
    /// mint without an escrow; the attestor cannot mint without a depositor.
    ///
    /// The opposite direction takes no such shortcut. Flare's data layer
    /// publishes Merkle roots signed by a weighted validator set, so proving a
    /// Flare event on Mina needs signature verification rather than recursive
    /// proof verification — affordable, and the roadmap's actual target.
    function claimWithMinaSignature(
        MinaSchnorr.PublicKey calldata publicKey,
        MinaSchnorr.Signature calldata signature,
        address recipient,
        uint64 amountNanomina,
        uint64 nonce,
        uint64 expiry,
        bytes calldata attestation
    ) external whenNotPaused nonReentrant {
        if (amountNanomina == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (expiry < block.timestamp) revert Expired(expiry, block.timestamp);
        if (escrowAttestor == address(0)) revert AttestorNotSet();

        bytes32 minaSender =
            bytes32(MinaAddressLib.raw(MinaAddressLib.pack(publicKey.x, publicKey.isOdd)));

        bytes32 intent = keccak256(
            abi.encode(
                DEPOSIT_INTENT_DOMAIN, block.chainid, minaSender, recipient, amountNanomina, nonce
            )
        );
        if (consumedIntents[intent]) revert IntentAlreadyConsumed(intent);

        // The attestor confirms this exact intent — it signs the digest, so it
        // cannot agree to one deposit and have another minted.
        address signer = ECDSA.recover(
            MessageHashUtils.toEthSignedMessageHash(intent), attestation
        );
        if (signer != escrowAttestor) revert InvalidAttestation();

        // The depositor's own authorisation, verified against Pallas on-chain.
        if (
            !MinaSchnorr.verify(
                publicKey,
                signature,
                depositIntentFields(recipient, amountNanomina, nonce, expiry),
                false
            )
        ) revert InvalidMinaSignature();

        consumedIntents[intent] = true;
        escrowedNanomina += amountNanomina;

        emit DepositMintedFromSignature(minaSender, recipient, nonce, amountNanomina);

        TOKEN.mint(recipient, amountNanomina);
    }

    /// @notice Set or rotate the escrow attestor.
    function setEscrowAttestor(address attestor) external onlyOwner {
        emit EscrowAttestorUpdated(escrowAttestor, attestor);
        escrowAttestor = attestor;
    }

    // -------------------------------------------------------------------------
    // Flare -> Mina
    // -------------------------------------------------------------------------

    /// @notice Burn FMINA and request the corresponding native MINA on Mina.
    /// @param amount Amount in FMINA base units (== nanomina).
    /// @param minaRecipient Mina account, packed as `x | isOdd << 255`.
    ///
    /// @dev The recipient is validated as a Pallas field element here rather
    /// than on the Mina side: a malformed key corresponds to no Mina account, so
    /// accepting it would burn the user's FMINA against an unclaimable escrow.
    function burnToMina(uint256 amount, bytes32 minaRecipient)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 nonce)
    {
        if (amount == 0) revert ZeroAmount();
        // The Mina side accounts in uint64 nanomina; reject anything it cannot represent.
        if (amount > type(uint64).max) revert AmountExceedsUint64();
        MinaAddressLib.fromBytes32(minaRecipient);

        nonce = nextWithdrawalNonce;
        if (processedWithdrawalNonces[nonce]) revert WithdrawalNonceAlreadyUsed(nonce);
        processedWithdrawalNonces[nonce] = true;
        nextWithdrawalNonce = nonce + 1;

        escrowedNanomina -= amount;

        // Burn before emitting so a reverting burn cannot leave a claimable event.
        TOKEN.burn(msg.sender, amount);

        emit WithdrawToMina(nonce, msg.sender, minaRecipient, amount);
    }

    // -------------------------------------------------------------------------
    // Administration
    // -------------------------------------------------------------------------

    /// @notice Propose a new settlement verifier.
    ///
    /// @dev Rotating the verifier is the single most dangerous action available
    /// on this contract: a malicious verifier can mint unbacked FMINA. It is
    /// therefore gated by a two-step owner transfer (inherited), a
    /// {VERIFIER_UPDATE_DELAY} timelock, and an event at each step, so that
    /// holders have a window to exit before a rotation takes effect.
    function proposeVerifier(IMinaSettlementVerifier newVerifier) external onlyOwner {
        if (address(newVerifier) == address(0)) revert ZeroAddress();
        pendingVerifier = newVerifier;
        verifierUpdateReadyAt = block.timestamp + VERIFIER_UPDATE_DELAY;
        emit VerifierUpdateProposed(address(newVerifier), verifierUpdateReadyAt);
    }

    /// @notice Cancel a pending verifier rotation.
    function cancelVerifierUpdate() external onlyOwner {
        address cancelled = address(pendingVerifier);
        if (cancelled == address(0)) revert NoPendingVerifier();
        delete pendingVerifier;
        delete verifierUpdateReadyAt;
        emit VerifierUpdateCancelled(cancelled);
    }

    /// @notice Execute a pending verifier rotation once the timelock elapsed.
    function executeVerifierUpdate() external onlyOwner {
        if (address(pendingVerifier) == address(0)) revert NoPendingVerifier();
        if (block.timestamp < verifierUpdateReadyAt) {
            revert VerifierUpdateNotReady(verifierUpdateReadyAt);
        }

        address old = address(verifier);
        verifier = pendingVerifier;
        delete pendingVerifier;
        delete verifierUpdateReadyAt;
        emit VerifierUpdated(old, address(verifier));
    }

    /// @notice Emergency stop for every user-facing flow.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Leaf digest for a deposit, for off-chain claim tooling.
    function depositLeaf(MinaPortEncoding.Deposit calldata deposit) external pure returns (bytes32) {
        return MinaPortEncoding.hashDepositLeaf(deposit);
    }

    /// @notice True when the collateral invariant holds.
    /// @dev Should be true at every block; asserted in the test suite after
    /// every state-changing operation.
    function collateralInvariantHolds() external view returns (bool) {
        return TOKEN.totalSupply() == escrowedNanomina;
    }
}
