import {
  AccountUpdate,
  VerificationKey,
  Bool,
  Field,
  MerkleWitness,
  Poseidon,
  Permissions,
  PublicKey,
  SmartContract,
  State,
  Struct,
  UInt64,
  method,
  state,
} from 'o1js';

/**
 * Token admin for the Flare -> Mina direction.
 *
 * # Why the default admin is not usable here
 *
 * `FungibleTokenAdmin.canMint` calls `ensureAdminSignature()` and returns true.
 * That makes minting a function of a private key: whoever holds it can mint
 * unbacked supply at will. For an ordinary token that is a reasonable trust
 * model. For a bridge it collapses every cryptographic guarantee onto one key —
 * the whole point of proving the Flare-side lock disappears if a signature can
 * bypass it.
 *
 * # What this admin does instead
 *
 * `canMint` trusts no key. It verifies that the mint in front of it is exactly
 * the one a proven claim authorised, and consumes that authorisation so it
 * cannot be used twice:
 *
 * ```text
 * transaction 1: authorizeClaim(claim, claimWitness, nullifierWitness)
 *     verify the leaf against `lockRoot`      <- proven Flare-side lock
 *     verify and consume the nullifier         <- no double claim
 *     mintAuthorization := H(recipient, amount)
 *
 * transaction 2: token.mint(recipient, amount)
 *     -> canMint(accountUpdate)
 *          recompute H from the account update itself
 *          assert it equals mintAuthorization
 *          mintAuthorization := EMPTY          <- one shot
 * ```
 *
 * # Why two transactions
 *
 * They cannot be combined, and this was established by test rather than by
 * reading: a second account update on the same zkApp does not observe state
 * written by an earlier one in the same transaction, because preconditions are
 * evaluated against the state as of the transaction's start. Bundling them makes
 * `canMint` read an empty `mintAuthorization` and refuse, even with a valid
 * claim armed a few lines above.
 *
 * Security does not depend on atomicity. The one-shot property comes from the
 * nullifier consumed in `authorizeClaim` and from `canMint` clearing the
 * authorisation; neither cares about transaction boundaries. An abandoned
 * authorisation blocks only its own claimant, who can complete it at any later
 * time. What is lost is convenience, not safety.
 *
 * The commitment is recomputed from the `AccountUpdate` the token actually
 * built, not from arguments the caller supplies, so a mint of a different
 * amount or to a different account cannot satisfy it.
 *
 * # HACKATHON TRUST ASSUMPTION
 *
 * `lockRoot` is set by `attestor`, a designated key, rather than by verifying a
 * Flare state proof on Mina. That is the one trusted component, it is a single
 * explicit state field, and replacing it with FDC + Relay verification changes
 * nothing else in this contract. Everything below it — claim uniqueness, amount
 * binding, recipient binding, one-shot minting — is enforced by the circuit and
 * survives the swap unchanged.
 */

/** Depth of the lock and nullifier trees. 2^20 claims is ample for the MVP. */
export const CLAIM_TREE_HEIGHT = 21;

export class ClaimWitness extends MerkleWitness(CLAIM_TREE_HEIGHT) {}

/** Sentinel meaning "no mint is currently authorised". */
export const NO_MINT_AUTHORIZED = Field(0);

/** Domain tag, so a claim leaf cannot be reinterpreted as any other structure. */
export const CLAIM_DOMAIN = Field(0x464c415245324d4en); // "FLARE2MN"

/**
 * A proven Flare-side lock entitling `recipient` to `amount` on Mina.
 *
 * Field order is protocol: it is mirrored by the Flare-side encoder that builds
 * the tree.
 */
export class LockClaim extends Struct({
  /** Unique per lock; also the nullifier preimage. */
  claimId: Field,
  recipient: PublicKey,
  amount: UInt64,
}) {
  /** Leaf committed in `lockRoot`. */
  hash(): Field {
    return Poseidon.hash([
      CLAIM_DOMAIN,
      this.claimId,
      this.recipient.x,
      this.recipient.isOdd.toField(),
      this.amount.value,
    ]);
  }
}

/**
 * Commitment to a specific mint.
 *
 * Deliberately computed from `(recipient, amount)` only. `canMint` has no access
 * to the claim id, so binding to it would be unverifiable there; uniqueness is
 * already enforced by the nullifier at authorisation time.
 */
export function mintCommitment(recipient: PublicKey, amount: UInt64): Field {
  return Poseidon.hash([recipient.x, recipient.isOdd.toField(), amount.value]);
}

export class BridgeTokenAdmin extends SmartContract {
  /** Merkle root over claims proven to be backed by a Flare-side lock. */
  @state(Field) lockRoot = State<Field>();

  /** Merkle root over consumed claim ids. */
  @state(Field) nullifierRoot = State<Field>();

  /** Commitment to the mint currently authorised, or {NO_MINT_AUTHORIZED}. */
  @state(Field) mintAuthorization = State<Field>();

  /**
   * Key allowed to publish a new `lockRoot`.
   *
   * The single trusted component; see the note on this class. It cannot mint,
   * cannot choose recipients or amounts, and cannot bypass the nullifier — it
   * can only publish the set of claims the Flare side has already committed to.
   */
  @state(PublicKey) attestor = State<PublicKey>();

  override async deploy(args: {
    attestor: PublicKey;
    lockRoot: Field;
    nullifierRoot: Field;
  } & Parameters<SmartContract['deploy']>[0]) {
    await super.deploy(args);

    this.attestor.set(args.attestor);
    this.lockRoot.set(args.lockRoot);
    this.nullifierRoot.set(args.nullifierRoot);
    this.mintAuthorization.set(NO_MINT_AUTHORIZED);

    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proof(),
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
    });
  }

  /** Publish a new set of proven locks. Attestor only. */
  @method async publishLockRoot(newRoot: Field) {
    const attestor = this.attestor.getAndRequireEquals();
    AccountUpdate.createSigned(attestor).body.useFullCommitment = Bool(true);

    this.lockRoot.getAndRequireEquals();
    this.lockRoot.set(newRoot);
  }

  /**
   * Verify a claim and arm the single mint it entitles.
   *
   * @param claim the lock being claimed
   * @param claimWitness inclusion of `claim` in `lockRoot`
   * @param nullifierWitness inclusion of the EMPTY slot for this claim id in
   *        `nullifierRoot`, proving it has not been consumed
   */
  @method async authorizeClaim(
    claim: LockClaim,
    claimWitness: ClaimWitness,
    nullifierWitness: ClaimWitness,
  ) {
    claim.amount.assertGreaterThan(UInt64.zero, 'claim amount must be non-zero');

    // The claim must be one the Flare side committed to.
    const lockRoot = this.lockRoot.getAndRequireEquals();
    claimWitness.calculateRoot(claim.hash()).assertEquals(lockRoot, 'claim not in lockRoot');

    // Its slot in the nullifier tree must still be empty, and the index must be
    // the claim id — binding the slot to the claim rather than letting the
    // caller point at any unused leaf.
    const nullifierRoot = this.nullifierRoot.getAndRequireEquals();
    nullifierWitness
      .calculateRoot(Field(0))
      .assertEquals(nullifierRoot, 'claim already consumed');
    nullifierWitness.calculateIndex().assertEquals(claim.claimId, 'nullifier slot mismatch');

    // Consume it.
    this.nullifierRoot.set(nullifierWitness.calculateRoot(Field(1)));

    // Arm exactly one mint. Overwriting an armed authorisation is refused so a
    // caller cannot stack two claims and mint only the larger one.
    const armed = this.mintAuthorization.getAndRequireEquals();
    armed.assertEquals(NO_MINT_AUTHORIZED, 'a mint is already authorised');
    this.mintAuthorization.set(mintCommitment(claim.recipient, claim.amount));
  }

  /**
   * Called by the token during `mint`. Trusts no key.
   *
   * The commitment is recomputed from the `AccountUpdate` the token built, so
   * the recipient and amount checked here are the ones actually being minted,
   * not values a caller passed in.
   */
  @method.returns(Bool) async canMint(accountUpdate: AccountUpdate): Promise<Bool> {
    const armed = this.mintAuthorization.getAndRequireEquals();
    armed.assertNotEquals(NO_MINT_AUTHORIZED, 'no mint is authorised');

    const recipient = accountUpdate.body.publicKey;
    const balanceChange = accountUpdate.body.balanceChange;

    // A mint is a positive balance change; a negative one would be a burn
    // smuggled through the mint path.
    balanceChange.isPositive().assertTrue('mint must increase the balance');
    const amount = balanceChange.magnitude;

    mintCommitment(recipient, amount).assertEquals(armed, 'mint does not match the claim');

    // One shot: the next mint needs a fresh claim.
    this.mintAuthorization.set(NO_MINT_AUTHORIZED);

    return Bool(true);
  }

  /**
   * The admin key may not be changed, and the token may not be paused.
   *
   * Both would be levers over user funds that no one should hold in a bridge.
   * Returning false rather than omitting them keeps the contract compatible
   * with `FungibleTokenAdminBase` while removing the capability.
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
   * Refuse to let the token's verification key be swapped.
   *
   * Required by `mina-fungible-token` 1.1.0. Swapping the verification key
   * replaces the token's entire logic, which would let an upgrade mint around
   * every check in this contract. Nobody should hold that in a bridge, so the
   * answer is no — permanently, and by proof rather than by policy.
   */
  @method.returns(Bool) async canChangeVerificationKey(_vk: VerificationKey): Promise<Bool> {
    return Bool(false);
  }

  /** Exposed for tests and tooling. */
  static commitment(recipient: PublicKey, amount: UInt64): Field {
    return mintCommitment(recipient, amount);
  }
}
