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
import { LockChainProof, LockRecord, applyLock } from './LockChain.js';
import { SigningPolicyProof } from './SigningPolicyFold.js';

/**
 * Mina side of the asset bridge: one port per wrapped Flare asset.
 *
 * It is the token's admin contract, so nothing mints without passing through
 * here. Where {BridgeTokenAdmin} trusted a key to publish a Merkle root, this
 * replays Flare's Poseidon lock chain against a state the Flare validator set
 * signed — the same mechanism the MINA rail already uses for withdrawals.
 *
 * ```text
 * publishFlareLockState(state, policyProof)   <- validator signatures
 * authorizeMint(record, tail)                 <- record + continuation to state
 * token.mint(recipient, amount) -> canMint    <- one shot, bound to the record
 * ```
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

  /** Commitment to the mint currently authorised, or {NO_MINT_AUTHORIZED}. */
  @state(Field) mintAuthorization = State<Field>();

  /**
   * Admin key. Rotates the policy root and co-signs published lock states.
   *
   * HACKATHON TRUST ASSUMPTION, and the same one the MINA rail carries: nothing
   * yet binds a published state to the FDC round root, so this signature stands
   * in for that check. It cannot mint, choose a recipient or an amount, or skip
   * a link in the chain.
   */
  @state(PublicKey) admin = State<PublicKey>();

  override async deploy(
    args: DeployArgs & {
      admin: PublicKey;
      signingPolicyRoot?: Field;
      requiredWeight?: UInt64;
    },
  ) {
    await super.deploy(args);
    this.admin.set(args.admin);
    this.signingPolicyRoot.set(args.signingPolicyRoot ?? Field(0));
    this.requiredWeight.set(args.requiredWeight ?? UInt64.zero);
  }

  override init() {
    super.init();
    // Zero is the empty chain on both sides: `lockActionStateOf` starts there
    // too, so a fresh port is already in agreement with the vault.
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
  @method async setSigningPolicyRoot(root: Field) {
    const admin = this.admin.getAndRequireEquals();
    AccountUpdate.createSigned(admin).body.useFullCommitment = Bool(true);

    this.signingPolicyRoot.getAndRequireEquals();
    this.signingPolicyRoot.set(root);
  }

  /**
   * Accept a new attested head of the lock chain. Separate from minting because
   * establishing it costs ECDSA and keccak, identical across a whole batch.
   */
  @method async publishFlareLockState(lockState: Field, proof: SigningPolicyProof) {
    proof.verify();

    proof.publicOutput.policy.assertEquals(
      this.signingPolicyRoot.getAndRequireEquals(),
      'proof is against a different signing policy',
    );

    const required = this.requiredWeight.getAndRequireEquals();
    proof.publicOutput.weight.value.assertGreaterThanOrEqual(
      required.value,
      'signing weight below the required threshold',
    );

    const admin = this.admin.getAndRequireEquals();
    AccountUpdate.createSigned(admin).body.useFullCommitment = Bool(true);

    this.flareLockState.getAndRequireEquals();
    this.flareLockState.set(lockState);
  }

  /**
   * Arm the mint for the next lock. The record is untrusted; `tail` constrains
   * it, since no fabricated record has a continuation reaching the attested
   * state. Advances the cursor, so two claims in one block conflict.
   */
  @method async authorizeMint(record: LockRecord, tail: LockChainProof) {
    record.amount.assertGreaterThan(UInt64.zero, 'lock amount must be non-zero');

    tail.verify();

    // This record's own link is computed here, not taken from the proof: it is
    // what binds the recipient and amount being minted to the chain.
    const processed = this.processedLockState.getAndRequireEquals();
    const next = applyLock(processed, record);

    tail.publicOutput.from.assertEquals(next, 'tail does not continue from this lock');
    tail.publicOutput.to.assertEquals(
      this.flareLockState.getAndRequireEquals(),
      'tail does not reach the attested Flare state',
    );

    // Refuse to overwrite an armed authorisation, so a caller cannot stack two
    // claims and mint only the larger one.
    const armed = this.mintAuthorization.getAndRequireEquals();
    armed.assertEquals(NO_MINT_AUTHORIZED, 'a mint is already authorised');

    this.processedLockState.set(next);
    this.mintAuthorization.set(mintCommitment(record.recipient, record.amount));
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
