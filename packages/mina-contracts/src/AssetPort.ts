import {
  AccountUpdate,
  Bool,
  DeployArgs,
  Field,
  Permissions,
  Poseidon,
  PublicKey,
  SmartContract,
  State,
  UInt64,
  VerificationKey,
  method,
  state,
} from 'o1js';
import { TransferChainProof } from './TransferChain.js';
import { FdcAttestationProof } from './FdcAttestation.js';
import { FDC_PROTOCOL_ID } from './RelayMessage.js';

/**
 * Mina side of the asset bridge: one port per wrapped Flare asset.
 *
 * It is the token's admin contract, so nothing mints without passing through
 * here. Where {BridgeTokenAdmin} trusted a key to publish a Merkle root, this
 * replays Flare's Poseidon lock chain against a state the Flare validator set
 * signed — the same mechanism the MINA rail already uses for withdrawals.
 *
 * ```text
 * publishFlareLockState(attestation)          <- FDC event, validator-signed
 * authorizeMint(segment)                      <- cursor -> attested head
 * token.mint(recipient, amount) -> canMint    <- one shot, bound to the record
 * ```
 *
 * The chain it replays carries every bridged asset, so a segment steps over
 * records belonging to the other ports. Which ones those are is decided in
 * circuit, not by the caller: see {TransferChain}.
 *
 * Two transactions, not one, and established by test rather than by reading: a
 * second account update on the same zkApp does not observe state written by an
 * earlier one in the same transaction, so bundling makes `canMint` read an
 * empty authorisation and refuse. Safety does not depend on atomicity — the
 * one-shot property comes from `processedLockState` advancing and from
 * `canMint` clearing the authorisation.
 */

/** Domain tag, distinct from every other commitment in this project. */
export const MINT_DOMAIN = Field(0x4c4f434b324d4e54n); // "LOCK2MNT"

/**
 * Commitment to a specific mint. Computed from `(recipient, amount)` only:
 * `canMint` cannot see the claim id, so binding to it would be unverifiable
 * there, and uniqueness already comes from the chain cursor.
 */
export function mintCommitment(recipient: PublicKey, amount: UInt64): Field {
  return Poseidon.hash([MINT_DOMAIN, recipient.x, recipient.isOdd.toField(), amount.value]);
}

/** Commitment to the admin key, so it costs one state field instead of two. */
export function adminCommitment(admin: PublicKey): Field {
  return Poseidon.hash([ADMIN_DOMAIN, admin.x, admin.isOdd.toField()]);
}

/** Domain tag for {adminCommitment}. */
export const ADMIN_DOMAIN = Field(0x41444d494e5f5631n); // "ADMIN_V1"

/** Sentinel meaning "no mint is currently authorised". */
export const NO_MINT_AUTHORIZED = Field(0);

export class AssetPort extends SmartContract {
  /** Poseidon root over Flare's signing policy, one leaf per validator. */
  @state(Field) signingPolicyRoot = State<Field>();

  /** Newest attested head of this token's Flare lock chain. Append-only. */
  @state(Field) flareLockState = State<Field>();

  /** How far along that chain this port has minted. */
  @state(Field) processedLockState = State<Field>();

  /** Signing weight a policy proof must carry. */
  @state(UInt64) requiredWeight = State<UInt64>();

  /**
   * The token this port administers, as a 160-bit Flare address.
   *
   * The chain is shared, so this is the only thing separating one port's
   * transfers from another's. Without it every port would mint against every
   * lock.
   */
  @state(Field) asset = State<Field>();

  /** Commitment to the mint currently authorised, or {NO_MINT_AUTHORIZED}. */
  @state(Field) mintAuthorization = State<Field>();

  /**
   * The Flare `TransferChain` whose events this port accepts, as a 160-bit
   * field. Pinned because the attestation proves an event happened, not that it
   * was ours.
   */
  @state(Field) flareChain = State<Field>();

  /**
   * Poseidon hash of the admin key, not the key itself: a `PublicKey` costs two
   * of the eight state fields and the eighth is spent on {asset}. The key is
   * passed to {setSigningPolicyRoot} and checked against this.
   *
   * Its only power is rotating the signing-policy root, which Flare forces every
   * reward epoch. It cannot publish a state, mint, choose a recipient or an
   * amount, or skip a link: those are all proven.
   */
  @state(Field) adminHash = State<Field>();

  override async deploy(
    args: DeployArgs & {
      admin: PublicKey;
      /** The Flare `TransferChain`, as a 160-bit field. */
      flareChain: Field;
      /** The token this port administers, as a 160-bit Flare address. */
      asset: Field;
      signingPolicyRoot?: Field;
      requiredWeight?: UInt64;
    },
  ) {
    await super.deploy(args);
    this.adminHash.set(adminCommitment(args.admin));
    this.flareChain.set(args.flareChain);
    this.asset.set(args.asset);
    this.signingPolicyRoot.set(args.signingPolicyRoot ?? Field(0));
    this.requiredWeight.set(args.requiredWeight ?? UInt64.zero);
  }

  override init() {
    super.init();
    // Zero is the empty chain on both sides: `TransferChain.head` starts there
    // too, so a fresh port is already in agreement with Flare.
    this.flareLockState.set(Field(0));
    this.processedLockState.set(Field(0));
    this.mintAuthorization.set(NO_MINT_AUTHORIZED);

    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proof(),
      // Upgradable by signature from the zkApp's own key: every circuit change
      // produces a new verification key, and with the key locked, shipping one
      // means abandoning the token this port administers. See MinaPortBridge.
      setVerificationKey: Permissions.VerificationKey.signature(),
      setPermissions: Permissions.impossible(),
    });
  }

  /**
   * Rotate the signing-policy root. Mandatory, not administrative: Flare's
   * validator set changes every reward epoch — 6h on Coston2 — and a fixed root
   * would stop accepting proofs at the first change.
   */
  @method async setSigningPolicyRoot(root: Field, admin: PublicKey) {
    adminCommitment(admin).assertEquals(
      this.adminHash.getAndRequireEquals(),
      'not the admin key',
    );
    AccountUpdate.createSigned(admin).body.useFullCommitment = Bool(true);

    this.signingPolicyRoot.getAndRequireEquals();
    this.signingPolicyRoot.set(root);
  }

  /**
   * Accept a new head of the lock chain, read out of an attested Flare event.
   *
   * Nothing here is asserted by a key. The proof establishes that enough of
   * Flare's validator set signed an FDC round, that the attestation response
   * sits under that round's root, and that the state below was read from the
   * event inside it. The vault address and event signature are pinned so one
   * asset's chain cannot be advanced by another's event.
   *
   * Separate from minting because establishing a head costs ECDSA and keccak,
   * and is identical across the whole batch it covers.
   */
  @method async publishFlareLockState(attestation: FdcAttestationProof) {
    attestation.verify();
    const attested = attestation.publicOutput;

    attested.policy.assertEquals(
      this.signingPolicyRoot.getAndRequireEquals(),
      'proof is against a different signing policy',
    );

    const required = this.requiredWeight.getAndRequireEquals();
    attested.weight.value.assertGreaterThanOrEqual(
      required.value,
      'signing weight below the required threshold',
    );

    // FDC rounds are the ones carrying attestation roots.
    attested.protocolId.value.assertEquals(Field(FDC_PROTOCOL_ID), 'not an FDC round');

    // The event has to come from the shared chain.
    attested.emitter.assertEquals(
      this.flareChain.getAndRequireEquals(),
      'the event came from another contract',
    );

    this.flareLockState.getAndRequireEquals();
    this.flareLockState.set(attested.actionState);
  }

  /**
   * Arm the mint for the next lock of this asset.
   *
   * Nothing is passed in but the segment: recipient and amount come out of the
   * proof, which spans the cursor to the attested head and names the first
   * record of this port's asset in that range. Locks of other assets in between
   * are stepped over, proven foreign in circuit — the caller does not get to
   * choose what to skip. Advances the cursor, so two claims in one block
   * conflict.
   */
  @method async authorizeMint(segment: TransferChainProof) {
    segment.verify();
    const found = segment.publicOutput;

    found.token.assertEquals(
      this.asset.getAndRequireEquals(),
      'segment was examined for another asset',
    );
    found.from.assertEquals(
      this.processedLockState.getAndRequireEquals(),
      'segment does not start at the cursor',
    );
    found.to.assertEquals(
      this.flareLockState.getAndRequireEquals(),
      'segment does not reach the attested Flare state',
    );
    found.found.assertTrue('no lock to mint');
    found.firstAmount.assertGreaterThan(UInt64.zero, 'lock amount must be non-zero');

    // Refuse to overwrite an armed authorisation, so a caller cannot stack two
    // claims and mint only the larger one.
    const armed = this.mintAuthorization.getAndRequireEquals();
    armed.assertEquals(NO_MINT_AUTHORIZED, 'a mint is already authorised');

    this.processedLockState.set(found.stateAfterFirst);
    this.mintAuthorization.set(mintCommitment(found.firstRecipient, found.firstAmount));
  }

  /**
   * Called by the token during `mint`. Trusts no key: the commitment is
   * recomputed from the account update the token built, so a mint of a
   * different amount or to a different account cannot satisfy it.
   */
  @method.returns(Bool) async canMint(accountUpdate: AccountUpdate): Promise<Bool> {
    const armed = this.mintAuthorization.getAndRequireEquals();
    armed.assertNotEquals(NO_MINT_AUTHORIZED, 'no mint is authorised');

    const balanceChange = accountUpdate.body.balanceChange;
    // A mint is a positive balance change; a negative one would be a burn
    // smuggled through the mint path.
    balanceChange.isPositive().assertTrue('mint must increase the balance');

    mintCommitment(accountUpdate.body.publicKey, balanceChange.magnitude).assertEquals(
      armed,
      'mint does not match the authorised lock',
    );

    this.mintAuthorization.set(NO_MINT_AUTHORIZED);
    return Bool(true);
  }

  /**
   * The admin key may not be changed, and the token may not be paused. Both
   * would be levers over user funds that nobody should hold in a bridge.
   */
  @method.returns(Bool) async canChangeAdmin(_admin: PublicKey): Promise<Bool> {
    return Bool(false);
  }

  @method.returns(Bool) async canPause(): Promise<Bool> {
    return Bool(false);
  }

  @method.returns(Bool) async canResume(): Promise<Bool> {
    return Bool(false);
  }

  /**
   * Refuse to let the token's verification key be swapped. Required by
   * `mina-fungible-token` 1.1.0; an upgrade there would mint around every check
   * in this contract.
   */
  @method.returns(Bool) async canChangeVerificationKey(_vk: VerificationKey): Promise<Bool> {
    return Bool(false);
  }
}
