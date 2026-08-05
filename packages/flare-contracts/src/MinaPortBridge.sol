// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from
    "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
// Not the upgradeable variant: OpenZeppelin 5.7 removed it because the base
// guard became proxy-safe. It keeps its flag in an ERC-7201 namespaced slot
// rather than an inherited variable, so it claims no space in this contract's
// layout, and its check is `== ENTERED` — an uninitialised slot reads as "not
// entered", which is what a proxy that never ran the constructor leaves behind.
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {UUPSUpgradeable} from
    "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
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
/// # Upgradability
///
/// UUPS behind an ERC-1967 proxy, so the bridge address is permanent. That is
/// worth more than the ability to fix bugs: `FMINA.BRIDGE` is immutable and
/// points here, so without a stable address every new implementation would mean
/// a new token and every holder of the old one left with nothing enforcing it.
/// The proxy removes that problem rather than working around it.
///
/// The cost is that `owner` can replace this logic entirely, including with
/// logic that mints without collateral. It is recorded in docs/threat-model.md
/// beside the other trusted keys rather than treated as infrastructure.
contract MinaPortBridge is
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable
{
    using MinaPortEncoding for MinaPortEncoding.Deposit;

    // -------------------------------------------------------------------------
    // Deployment constants
    //
    // Storage rather than `immutable`: an immutable is baked into the
    // implementation's bytecode, and the proxy runs a different implementation
    // after every upgrade. These have to live in the proxy's storage or they
    // would silently reset on the first upgrade.
    // -------------------------------------------------------------------------

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

    /// @notice Running Poseidon commitment to every withdrawal ever emitted.
    ///
    /// @dev The same shape as a Mina action state: each withdrawal folds into
    /// the previous value, so one field element commits to the whole ordered
    /// history. Starts at zero, which is the empty chain.
    ///
    /// This exists so the Mina side has something cheap to verify. Replaying a
    /// link costs 13 rows in a Mina circuit against 14,733 for one keccak level,
    /// so a chain the escrow zkApp can replay directly is worth far more than a
    /// tree it would have to walk in Ethereum's hash. Emitting it is not enough:
    /// the contract has to read the previous value to compute the next one.
    uint256 public withdrawalActionState;

    /// @notice Domain separator for the withdrawal chain, as o1js `prefixToField`
    /// packs it: the UTF-8 bytes of "MinaPortWithdrawV1", zero-padded to 32 and
    /// read little-endian.
    ///
    /// @dev Domain separation is not decoration here. Without it a digest from
    /// one part of the protocol could be replayed as a link in this chain.
    uint256 internal constant WITHDRAWAL_PREFIX_FIELD =
        4297924978315896314651171907962194736605517;

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
    ///
    /// @dev `newActionState` is what an FDC attestation ultimately carries to
    /// Mina. Replaying the chain needs every link, not just the last one, so
    /// each withdrawal publishes both its own fields and the state they produce.
    event WithdrawToMina(
        uint256 indexed nonce,
        address indexed sender,
        bytes32 indexed minaRecipient,
        uint256 amount,
        uint256 previousActionState,
        uint256 newActionState
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

    /// @dev Disables initialisers on the implementation itself. Without this,
    /// anyone can call `initialize` directly on the implementation and become
    /// its owner — and since UUPS puts `upgradeToAndCall` in the implementation
    /// rather than the proxy, that owner can brick what the proxy delegates to.
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
    /// @dev FMINA is deployed here rather than passed in, so its immutable
    /// bridge address is the proxy — which never changes — and an upgrade
    /// cannot orphan holders.
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

    /// @dev Only the owner may install a new implementation.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Free storage slots reserved for future variables.
    /// @dev Appending a variable in a later version must not shift anything
    /// this version already wrote. Consuming a gap slot instead keeps every
    /// existing offset fixed, which is the whole discipline of upgradeable
    /// storage — get it wrong once and the balances read as something else.
    uint256[45] private __gap;

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

        nonce = nextWithdrawalNonce;
        if (processedWithdrawalNonces[nonce]) revert WithdrawalNonceAlreadyUsed(nonce);
        processedWithdrawalNonces[nonce] = true;
        nextWithdrawalNonce = nonce + 1;

        escrowedNanomina -= amount;

        // Fold this withdrawal into the running commitment. The record is
        // hashed, not the signature that authorised it: Mina needs the recipient
        // and the amount to pay out, so those are what must be bound. Flare has
        // already checked the signature by the time this runs.
        uint256 previousActionState = withdrawalActionState;
        uint256[] memory fields = new uint256[](5);
        fields[0] = previousActionState;
        fields[1] = nonce;
        fields[2] = recipientX;
        fields[3] = recipientIsOdd ? 1 : 0;
        fields[4] = amount;
        uint256 newActionState =
            PoseidonPallas.hashWithPrefix(WITHDRAWAL_PREFIX_FIELD, fields);
        withdrawalActionState = newActionState;

        // Burn before emitting so a reverting burn cannot leave a claimable event.
        TOKEN.burn(msg.sender, amount);

        emit WithdrawToMina(
            nonce, msg.sender, minaRecipient, amount, previousActionState, newActionState
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
