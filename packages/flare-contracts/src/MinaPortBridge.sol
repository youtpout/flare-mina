// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from
    "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
// Not `ReentrancyGuardUpgradeable`: OZ 5.7 removed it and its CHANGELOG names
// this import as the migration. The guard keeps its flag in an ERC-7201 slot,
// so it needs no initialiser and an uninitialised slot reads as "not entered".
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {FMINA} from "./FMINA.sol";
import {MinaAddressLib} from "./libraries/MinaAddress.sol";
import {MinaSchnorr} from "./libraries/MinaSchnorr.sol";
import {PoseidonPallas} from "./libraries/PoseidonPallas.sol";
import {SignaturePurpose} from "./libraries/SignaturePurpose.sol";
import {MinaPortEncoding} from "./libraries/MinaPortEncoding.sol";
import {IMinaSettlementVerifier, SettlementPublicValues} from "./interfaces/IMinaSettlementVerifier.sol";
import {TransferChain} from "./TransferChain.sol";

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
/// Behind a transparent proxy, so the bridge address is permanent — `FMINA.BRIDGE`
/// is immutable and points here. Transparent rather than UUPS: the upgrade logic
/// lives in the proxy, and this contract is already near the EIP-170 limit.
contract MinaPortBridge is Ownable2StepUpgradeable, PausableUpgradeable, ReentrancyGuard {
    using MinaPortEncoding for MinaPortEncoding.Deposit;

    // Storage, not `immutable`: an immutable lives in the implementation's
    // bytecode, and the proxy runs a new implementation after every upgrade.

    /// @notice The FMINA token. Deployed by this contract so the mint/burn
    /// authority can never be pointed at a token the bridge does not control.
    FMINA public TOKEN;

    /// @notice Binds this bridge to one Mina zkApp on one Mina network.
    /// @dev Every accepted batch must carry this exact id, so a proof produced
    /// for a devnet deployment can never settle on a mainnet bridge.
    bytes32 public BRIDGE_ID;

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

    /// @notice DEPRECATED. This rail's own withdrawal chain, before every asset
    /// was folded into {TransferChain}. Kept so the proxy's storage layout does
    /// not shift; frozen at whatever it held at the upgrade.
    uint256 public withdrawalActionState;

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

    /// @notice A withdrawal, as this bridge saw it. Informational: what Mina
    /// proves against is {TransferChain-Transfer}, and `nonce` here is that
    /// chain's global index so the two can be lined up.
    event WithdrawToMina(
        uint256 indexed nonce,
        address indexed token,
        address indexed sender,
        bytes32 minaRecipient,
        uint256 amount,
        uint256 previousActionState,
        uint256 newActionState
    );

    event TransferChainSet(address indexed chain);

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
    error TransferChainNotSet();

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    /// @dev An implementation anyone can initialise is one anyone can own.
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialise the proxy. Runs once, in the proxy's storage.
    /// @param owner_ Initial owner (two-step transferable).
    /// @param verifier_ Settlement verifier. May be a mock during development.
    /// @param bridgeId_ Identifier of the Mina zkApp + network this bridge serves.
    /// @param genesisActionState Mina action state the bridge starts from,
    ///        i.e. the zkApp's `Reducer.initialActionState` at deployment.
    ///
    /// @dev FMINA is deployed here, so its immutable bridge is the proxy.
    function initialize(
        address owner_,
        IMinaSettlementVerifier verifier_,
        bytes32 bridgeId_,
        bytes32 genesisActionState
    ) external initializer {
        if (owner_ == address(0) || address(verifier_) == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __Pausable_init();

        verifier = verifier_;
        BRIDGE_ID = bridgeId_;
        currentMinaActionState = genesisActionState;
        TOKEN = new FMINA(address(this));

        // Bounded from block zero. An unset ceiling would make the signature
        // path unlimited by default, which is the exact exposure the ceiling
        // exists to remove.
        maxAttestedDepositNanomina = DEFAULT_MAX_ATTESTED_DEPOSIT;
        attestedMintCapNanomina = DEFAULT_ATTESTED_MINT_CAP;
        emit AttestedMintLimitsUpdated(DEFAULT_MAX_ATTESTED_DEPOSIT, DEFAULT_ATTESTED_MINT_CAP);
    }

    /// @notice The shared chain every withdrawal is folded into.
    TransferChain public transferChain;

    /// @notice Point withdrawals at the shared chain.
    /// @dev The chain must also grant this bridge `mayAppend` for FMINA.
    function setTransferChain(TransferChain chain) external onlyOwner {
        if (address(chain) == address(0)) revert ZeroAddress();
        transferChain = chain;
        emit TransferChainSet(address(chain));
    }

    /// @dev Room to append without shifting anything this version wrote.
    uint256[44] private __gap;

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
    /// cannot do, and {setAttestedMintLimits} for how much it is worth.
    address public escrowAttestor;

    /// @notice Deposit intents already minted, keyed by their digest.
    mapping(bytes32 => bool) public consumedIntents;

    /// @notice Largest single signature-path mint, in nanomina.
    uint64 public maxAttestedDepositNanomina;

    /// @notice Cumulative ceiling on signature-path minting, in nanomina.
    uint256 public attestedMintCapNanomina;

    /// @notice Signature-path minting so far, in nanomina. Never decreases.
    /// @dev Deliberately not reduced by `burnToMina`: the cap bounds how much
    /// an attestor key can ever have been worth, and a round trip through the
    /// bridge must not refill that allowance.
    uint256 public attestedMintedNanomina;

    /// @notice Pending limit raise, executable after `limitsUpdateReadyAt`.
    uint64 public pendingMaxAttestedDeposit;
    uint256 public pendingAttestedMintCap;
    uint256 public limitsUpdateReadyAt;

    /// @notice Default ceilings, applied at construction so the signature path
    /// is never live without one. 10,000 MINA per deposit, 100,000 cumulative.
    uint64 public constant DEFAULT_MAX_ATTESTED_DEPOSIT = 10_000e9;
    uint256 public constant DEFAULT_ATTESTED_MINT_CAP = 100_000e9;

    event EscrowAttestorUpdated(address indexed oldAttestor, address indexed newAttestor);
    event DepositMintedFromSignature(
        bytes32 indexed minaSender, address indexed recipient, uint64 nonce, uint64 amount
    );
    event AttestedMintLimitsUpdated(uint64 maxPerDeposit, uint256 cumulativeCap);
    event AttestedMintLimitsRaiseProposed(
        uint64 maxPerDeposit, uint256 cumulativeCap, uint256 readyAt
    );
    event AttestedMintLimitsRaiseCancelled();

    error IntentAlreadyConsumed(bytes32 intent);
    error InvalidMinaSignature();
    error InvalidAttestation();
    error AttestorNotSet();
    error DepositAbovePerDepositCap(uint64 amount, uint64 cap);
    error AttestedMintCapExceeded(uint256 minted, uint64 amount, uint256 cap);
    error NotARaise();
    error NoPendingLimits();
    error LimitsUpdateNotReady(uint256 readyAt);

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

        // The ceilings the attestor cannot ignore. The relayer applies its own
        // per-deposit policy, but that is an honest attestor restraining itself
        // and is worth nothing against a compromised key.
        if (amountNanomina > maxAttestedDepositNanomina) {
            revert DepositAbovePerDepositCap(amountNanomina, maxAttestedDepositNanomina);
        }
        uint256 minted = attestedMintedNanomina;
        if (minted + amountNanomina > attestedMintCapNanomina) {
            revert AttestedMintCapExceeded(minted, amountNanomina, attestedMintCapNanomina);
        }

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
        attestedMintedNanomina = minted + amountNanomina;

        emit DepositMintedFromSignature(minaSender, recipient, nonce, amountNanomina);

        TOKEN.mint(recipient, amountNanomina);
    }

    /// @notice Set or rotate the escrow attestor.
    function setEscrowAttestor(address attestor) external onlyOwner {
        emit EscrowAttestorUpdated(escrowAttestor, attestor);
        escrowAttestor = attestor;
    }

    /// @notice Lower either signature-path ceiling. Takes effect immediately.
    ///
    /// @dev Asymmetric on purpose. Lowering only ever reduces what an attestor
    /// key is worth, so making it instant is what lets an operator react to a
    /// suspected compromise within one block. Raising is the dangerous
    /// direction and goes through {proposeAttestedMintLimitsRaise}.
    ///
    /// The asymmetry is also what bounds a compromised *owner*: rotating the
    /// attestor is instant, so an attacker holding the owner key can mint — but
    /// only up to the ceiling in force today, not one they set themselves.
    function lowerAttestedMintLimits(uint64 maxPerDeposit, uint256 cumulativeCap)
        external
        onlyOwner
    {
        if (maxPerDeposit > maxAttestedDepositNanomina || cumulativeCap > attestedMintCapNanomina) {
            revert NotARaise();
        }
        maxAttestedDepositNanomina = maxPerDeposit;
        attestedMintCapNanomina = cumulativeCap;
        emit AttestedMintLimitsUpdated(maxPerDeposit, cumulativeCap);
    }

    /// @notice Propose raising either signature-path ceiling.
    /// @dev Subject to {VERIFIER_UPDATE_DELAY}, for the same reason the verifier
    /// rotation is: it increases how much unbacked supply a trusted key could
    /// produce, and holders are entitled to a window in which to exit.
    function proposeAttestedMintLimitsRaise(uint64 maxPerDeposit, uint256 cumulativeCap)
        external
        onlyOwner
    {
        pendingMaxAttestedDeposit = maxPerDeposit;
        pendingAttestedMintCap = cumulativeCap;
        limitsUpdateReadyAt = block.timestamp + VERIFIER_UPDATE_DELAY;
        emit AttestedMintLimitsRaiseProposed(maxPerDeposit, cumulativeCap, limitsUpdateReadyAt);
    }

    /// @notice Cancel a pending raise.
    function cancelAttestedMintLimitsRaise() external onlyOwner {
        if (limitsUpdateReadyAt == 0) revert NoPendingLimits();
        delete pendingMaxAttestedDeposit;
        delete pendingAttestedMintCap;
        delete limitsUpdateReadyAt;
        emit AttestedMintLimitsRaiseCancelled();
    }

    /// @notice Execute a pending raise once the timelock has elapsed.
    function executeAttestedMintLimitsRaise() external onlyOwner {
        if (limitsUpdateReadyAt == 0) revert NoPendingLimits();
        if (block.timestamp < limitsUpdateReadyAt) {
            revert LimitsUpdateNotReady(limitsUpdateReadyAt);
        }

        maxAttestedDepositNanomina = pendingMaxAttestedDeposit;
        attestedMintCapNanomina = pendingAttestedMintCap;
        delete pendingMaxAttestedDeposit;
        delete pendingAttestedMintCap;
        delete limitsUpdateReadyAt;

        emit AttestedMintLimitsUpdated(maxAttestedDepositNanomina, attestedMintCapNanomina);
    }

    /// @notice Signature-path minting still available under the cumulative cap.
    function remainingAttestedMintAllowance() external view returns (uint256) {
        uint256 minted = attestedMintedNanomina;
        return minted >= attestedMintCapNanomina ? 0 : attestedMintCapNanomina - minted;
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
        (uint256 recipientX, bool recipientIsOdd) =
            MinaAddressLib.unpack(MinaAddressLib.fromBytes32(minaRecipient));

        TransferChain chain = transferChain;
        if (address(chain) == address(0)) revert TransferChainNotSet();

        nextWithdrawalNonce += 1;
        escrowedNanomina -= amount;

        // Burn before folding: `append` is what makes the withdrawal claimable
        // on Mina, so nothing may revert after it.
        TOKEN.burn(msg.sender, amount);

        uint256 previousHead = chain.head();
        uint256 newHead;
        (nonce, newHead) =
            chain.append(address(TOKEN), msg.sender, minaRecipient, recipientX, recipientIsOdd, amount);
        processedWithdrawalNonces[nonce] = true;

        emit WithdrawToMina(
            nonce, address(TOKEN), msg.sender, minaRecipient, amount, previousHead, newHead
        );
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
