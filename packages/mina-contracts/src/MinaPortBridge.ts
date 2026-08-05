import {
  AccountUpdate,
  DeployArgs,
  Bool,
  Field,
  PublicKey,
  Reducer,
  SmartContract,
  State,
  Struct,
  UInt64,
  method,
  Permissions,
  Poseidon,
  state,
} from 'o1js';
import { DEPOSIT_DOMAIN, EVM_ADDRESS_BITS } from './constants.js';
import {
  WithdrawalChainProof,
  WithdrawalRecord,
  applyWithdrawal,
} from './WithdrawalChain.js';
import { SigningPolicyProof } from './SigningPolicyFold.js';

/** Re-exported so callers of this contract get the record from one place. */
export { WithdrawalRecord };

/**
 * MinaPort bridge zkApp — the Mina side of the MINA <-> wMINA bridge.
 *
 * Responsibilities:
 *   - Mina -> Flare: escrow native MINA and dispatch a canonical deposit action
 *     that the prover later aggregates into a batch settled on Flare.
 *   - Flare -> Mina: release escrowed MINA against a proven `WithdrawToMina`
 *     event (see the trust note on `releaseWithdrawal`).
 *
 * Collateral invariant: this account's balance is the exact amount of MINA held
 * on behalf of bridged users, and equals the FMINA total supply on Flare once
 * every in-flight batch has settled.
 */

/** A Flare address, big-endian, packed into a single field element (160 bits). */
export class FlareAddress extends Struct({ value: Field }) {
  /** Range-check: an EVM address must fit in exactly 160 bits. */
  assertValid(): void {
    this.value.assertLessThan(
      Field(2n ** BigInt(EVM_ADDRESS_BITS)),
      'flareRecipient exceeds 160 bits',
    );
  }
}

/**
 * The canonical deposit action.
 *
 * Field order here IS the protocol. It is mirrored by:
 *   - `minaport_core::leaf::DepositLeaf` (Rust, inside the SP1 guest)
 *   - `MinaPortEncoding.hashDepositLeaf` (Solidity, keccak variant)
 *
 * The Poseidon hash below is the Mina-native commitment; the SP1 guest proves
 * that each Poseidon leaf it consumed corresponds to the keccak leaf that ends
 * up in the Flare-facing Merkle tree.
 */
export class DepositAction extends Struct({
  nonce: UInt64,
  senderX: Field,
  senderIsOdd: Bool,
  flareRecipient: Field,
  amount: UInt64,
}) {
  hash(): Field {
    return Poseidon.hash([
      DEPOSIT_DOMAIN,
      this.nonce.value,
      this.senderX,
      this.senderIsOdd.toField(),
      this.flareRecipient,
      this.amount.value,
    ]);
  }
}

/**
 * A deposit, as a readable log line.
 *
 * Events and actions are not alternatives here, they answer different
 * questions. The action is the machine: it feeds `actionState`, which is the
 * commitment a settlement proof attests to. The event is the journal: nothing
 * on chain reads it, and it exists so a watcher that has not implemented the
 * action encoding can still see what happened.
 *
 * What it does NOT do is remove the archive-node dependency — events are
 * fetched the same way actions are. It buys readability, not availability.
 *
 * # What it costs
 *
 * ~53 rows per emit: `deposit` 744 -> 797, `releaseWithdrawal` 1006 -> 1058.
 * The second one crosses 1024, so the Pickles domain doubles to 2048.
 *
 * Proving measured 2.1 s without and 2.3 s with — but on a machine whose load
 * moved between the runs, and a follow-up that should have been *faster* came
 * out slower. The effect is at or below the noise floor here, so treat "about
 * 10%, maybe less" as the honest answer and re-measure on an idle machine
 * before optimising against it.
 *
 * It does not touch `actionState`, so it cannot affect settlement or the
 * concurrency property that keeps `deposit` free of state preconditions.
 */
export class DepositEvent extends Struct({
  nonce: UInt64,
  sender: PublicKey,
  flareRecipient: Field,
  amount: UInt64,
}) {}

/** A release, same purpose. */
export class WithdrawalEvent extends Struct({
  nonce: UInt64,
  recipient: PublicKey,
  amount: UInt64,
}) {}

/**
 * The deposit escrow.
 *
 * # Why there is almost no state here
 *
 * Three fields used to live on this contract and all three were duplicates:
 *
 *   - a hash chain over dispatched deposits — `reducer.dispatch` already
 *     advances the account's own `actionState`, which is what a settlement
 *     proof would attest to anyway. Ours was a second, parallel commitment
 *     that could only ever agree or be a bug;
 *   - a deposit-nonce counter — the nonce only has to make a deposit *unique*,
 *     and it travels inside the action where the Flare side reads it. Storing
 *     it bought sequentiality nobody needs and cost a read-modify-write that
 *     serialised every depositor against every other;
 *   - an escrowed-balance total — with `receive: Permissions.proof()` the
 *     balance cannot move except through these methods, so the account balance
 *     *is* the escrowed total. Tracking it separately meant maintaining a
 *     number the protocol already maintains, with the two able to disagree.
 *
 * The collateral invariant is unchanged in meaning:
 * `totalSupply(FMINA) == balance of this account`.
 */
export class MinaPortBridge extends SmartContract {
  /**
   * Poseidon Merkle root over Flare's signing policy: one leaf per validator,
   * committing to `(index, publicKey, weight)`.
   *
   * This is what makes a `SigningPolicyFold` proof mean something. Without it
   * the proof says only "n valid ECDSA signatures at distinct indices" — real,
   * but a prover could name any keys and claim any weights.
   *
   * Poseidon rather than Flare's keccak `toSigningPolicyHash`: this copy only
   * has to be correct, not identically encoded, and Poseidon costs 13 rows a
   * level against keccak's 14,636. Membership ends up at 132 rows beside the
   * 31,814 of the signature it accompanies.
   *
   * It occupies the field `lastWithdrawalNonce` used to hold. That check is
   * subsumed by the chain: a release must be the next link from the cursor, so
   * the nonce order is already forced and could not fail independently.
   */
  @state(Field) signingPolicyRoot = State<Field>();

  /**
   * Key authorised to attest a Flare -> Mina withdrawal.
   *
   * HACKATHON TRUST ASSUMPTION — this is the "temporary trusted signing-policy
   * checkpoint" described in docs/threat-model.md. The production design
   * replaces this with in-circuit verification of the Flare Relay signing
   * policy (FDC attestation + ECDSA set + weight threshold). It is deliberately
   * a single explicit state field so that removing it is a visible diff, not a
   * silent behaviour change.
   */
  @state(PublicKey) withdrawalAttestor = State<PublicKey>();

  /**
   * The newest state of Flare's withdrawal chain this bridge has accepted.
   *
   * Flare folds every withdrawal into a running Poseidon commitment, so this
   * one field element stands for the entire ordered history up to the moment it
   * was attested. Published once per batch, and every release in that batch
   * proves against it — the expensive verification is paid once and amortised
   * rather than repeated per withdrawal.
   *
   * A chain rather than a Merkle root because it is append-only: a newer state
   * contains every older one, so publishing does not strand a withdrawal that
   * missed its window. Remembering a set of independent roots would need state
   * this contract does not have — eight field elements, and the layout below
   * already uses all eight.
   */
  @state(Field) flareActionState = State<Field>();

  /**
   * How far along Flare's chain this bridge has released.
   *
   * Starts at zero, the empty chain, and advances by exactly one link per
   * release. The gap between this and `flareActionState` is what remains owed.
   */
  @state(Field) processedActionState = State<Field>();

  /**
   * Signing weight required before a root is accepted.
   *
   * Set at deployment rather than hard-coded, because the number that means
   * "the validators agreed" is a property of the network, not of this
   * contract: Coston2 has 8 voters and mainnet allows 100. A demo can require
   * very little and production the real threshold, without the circuits
   * changing.
   */
  @state(UInt64) requiredWeight = State<UInt64>();

  /**
   * Administrative key, fixed at deployment.
   *
   * The only privilege it holds is rotating `withdrawalAttestor`. It cannot
   * move funds, mint, or edit any accounting state — those are reachable only
   * through proof-authorised methods.
   */
  @state(PublicKey) admin = State<PublicKey>();

  reducer = Reducer({ actionType: DepositAction });

  override events = {
    deposit: DepositEvent,
    withdrawal: WithdrawalEvent,
  };

  /**
   * Deploy with an explicit admin and attestor.
   *
   * `super.deploy` runs `init()` (zeroing the accounting state and locking down
   * permissions); the two keys are written afterwards so the contract is never
   * live with an unset admin that a third party could claim.
   */
  override async deploy(
    args: DeployArgs & {
      admin: PublicKey;
      withdrawalAttestor: PublicKey;
      /** Poseidon root over Flare's validator set. Zero accepts no proof. */
      signingPolicyRoot?: Field;
      /** Signing weight a Flare root must carry. Zero accepts any. */
      requiredWeight?: UInt64;
    },
  ) {
    await super.deploy(args);
    this.admin.set(args.admin);
    this.withdrawalAttestor.set(args.withdrawalAttestor);
    this.requiredWeight.set(args.requiredWeight ?? UInt64.zero);
    this.signingPolicyRoot.set(args.signingPolicyRoot ?? Field(0));
  }

  override init() {
    super.init();
    // Zero is the empty chain on both sides: Flare's `withdrawalActionState`
    // starts there too, so a fresh bridge is already in agreement.
    this.flareActionState.set(Field(0));
    this.processedActionState.set(Field(0));

    this.account.permissions.set({
      ...Permissions.default(),
      // Balance may only move through this contract's own methods — in both
      // directions. `receive` matters as much as `send`, and it is what lets
      // this contract have no balance accounting of its own: if the only way
      // in is `deposit` and the only way out is `releaseWithdrawal`, then the
      // account balance is exactly the escrowed total, maintained by the
      // protocol rather than by us.
      //
      // It also removes a way to lose funds outright. A plain payment would
      // credit the balance without running `deposit`, so no action would ever
      // be dispatched and nothing on Flare could claim it.
      send: Permissions.proof(),
      receive: Permissions.proof(),
      editState: Permissions.proof(),
      // The verification key must not be swappable without an explicit upgrade.
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
    });
  }

  /**
   * Rotate the withdrawal attestor. Admin only.
   *
   * Authorised by a SEPARATE signed account update from the admin, not by
   * `this.requireSignature()`. That distinction is not stylistic: requiring the
   * zkApp's own signature switches this account update's authorisation kind
   * from proof to signature, which `editState: Permissions.proof()` then
   * rejects — the method simply cannot succeed. An earlier version shipped that
   * way and could never have rotated anything.
   *
   * The admin's only power is this rotation. It cannot move the escrow, mint,
   * or touch any accounting state, all of which are reachable only through
   * proof-authorised methods.
   */
  @method async setWithdrawalAttestor(attestor: PublicKey) {
    const admin = this.admin.getAndRequireEquals();
    const adminUpdate = AccountUpdate.createSigned(admin);
    adminUpdate.body.useFullCommitment = Bool(true);

    this.withdrawalAttestor.getAndRequireEquals();
    this.withdrawalAttestor.set(attestor);
  }

  /**
   * Lock native MINA and dispatch a deposit action.
   *
   * @param nonce chosen by the caller. It exists only to make a deposit
   *   *unique*, not to order deposits: the Flare side keys its consumed-intent
   *   set on `(sender, recipient, amount, nonce)`, so two otherwise identical
   *   deposits must differ here or the second cannot be claimed. Sixty-four
   *   random bits are enough; a counter is not required and is deliberately
   *   not enforced, since enforcing one would serialise every depositor
   *   against every other for no benefit.
   * @param flareRecipient the Flare address entitled to the minted FMINA,
   *   big-endian in the low 160 bits of a field element.
   * @param amount amount to lock, in nanomina. Must be non-zero.
   */
  @method async deposit(nonce: UInt64, flareRecipient: Field, amount: UInt64) {
    amount.assertGreaterThan(UInt64.zero, 'deposit amount must be non-zero');
    // Without this range check a recipient above 160 bits would be escrowed
    // against a Flare address that does not exist — funds locked forever.
    new FlareAddress({ value: flareRecipient }).assertValid();

    // Pull the funds. `createSigned` is what requires the sender's signature,
    // so the key is read unconstrained: a prover naming a sender it cannot
    // sign for produces a transaction that will not be accepted.
    // `getAndRequireSignature()` here would demand the same signature twice.
    //
    // The credit is applied to this contract's own account update rather than
    // through `senderUpdate.send(...)`. `send` would create a *separate*,
    // unauthorised update on the zkApp account, which `receive: proof()` then
    // refuses — the method would be unable to accept the very deposit it
    // exists for. Debiting the sender and crediting `this` keeps the increase
    // on the proof-authorised update.
    const sender = this.sender.getUnconstrained();
    const senderUpdate = AccountUpdate.createSigned(sender);
    senderUpdate.balance.subInPlace(amount);
    this.balance.addInPlace(amount);

    // The dispatch is the whole record. It advances the account's own
    // `actionState`, which is the commitment a settlement proof attests to —
    // maintaining a parallel hash chain in zkApp state would add a second
    // value that can only ever agree with this one or be a bug.
    this.reducer.dispatch(
      new DepositAction({
        nonce,
        senderX: sender.x,
        senderIsOdd: sender.isOdd,
        flareRecipient,
        amount,
      }),
    );
    this.emitEvent('deposit', new DepositEvent({ nonce, sender, flareRecipient, amount }));
  }

  /**
   * Accept a new state of Flare's withdrawal chain.
   *
   * # Why this is separate from releasing
   *
   * Establishing what Flare committed to is the expensive half — one secp256k1
   * verification is 31,814 rows and a threshold needs several, plus a keccak
   * Merkle path at 14,733 rows a level. Doing that inside `releaseWithdrawal`
   * would charge every user for work that is identical across a whole batch.
   *
   * So it happens once, here. Afterwards a release only replays chain links, at
   * 48 rows each — the cost is amortised over the batch rather than repeated.
   *
   * # What it does not check
   *
   * Two things, both tracked in docs/return-path.md.
   *
   * That the signers belong to Flare's signing policy: `SigningPolicyFold`
   * proves valid signatures at distinct ascending indices, but nothing yet binds
   * `(index, publicKey, weight)` to the policy they name.
   *
   * And that `actionState` is what those validators actually signed over. The
   * signed value is an FDC voting-round root; linking it to Flare's event needs
   * `MerkleInclusion` plus decoding of the attested response.
   *
   * Until both land, the attestor co-signs. That is a far smaller assumption
   * than before: the attestor is now trusted once per batch instead of once per
   * withdrawal, and it cannot choose recipients or amounts — those come from the
   * chain, and only the sequence Flare committed to reaches this state.
   */
  @method async publishFlareActionState(actionState: Field, proof: SigningPolicyProof) {
    proof.verify();

    // The signers must belong to the policy this bridge knows about, or the
    // weight below is a number the prover chose.
    proof.publicOutput.policy.assertEquals(
      this.signingPolicyRoot.getAndRequireEquals(),
      'proof is against a different signing policy',
    );

    const required = this.requiredWeight.getAndRequireEquals();
    proof.publicOutput.weight.value.assertGreaterThanOrEqual(
      required.value,
      'signing weight below the required threshold',
    );

    const attestor = this.withdrawalAttestor.getAndRequireEquals();
    const attestorUpdate = AccountUpdate.createSigned(attestor);
    attestorUpdate.body.useFullCommitment = Bool(true);

    this.flareActionState.getAndRequireEquals();
    this.flareActionState.set(actionState);
  }

  /**
   * Release escrowed MINA for the next withdrawal on Flare's chain.
   *
   * # What makes the withdrawal real
   *
   * The record itself is untrusted input. What constrains it is `tail`: a proof
   * that from the state this record produces, the rest of Flare's chain runs to
   * the attested state. No fabricated record has such a continuation, because
   * producing one means finding a Poseidon collision.
   *
   * So the caller cannot invent a withdrawal, redirect one, or change an amount
   * — every field is inside the hash that has to land on `flareActionState`.
   * There is no attestor here any more; the trust that remains sits in
   * `publishFlareActionState`, once per batch.
   *
   * # Why releases are serialised
   *
   * This reads and writes the cursor, so two releases in one block conflict.
   * That is inherent to a chain: withdrawals are released in Flare's order, one
   * at a time. Deposits stay concurrent because they read no state.
   */
  @method async releaseWithdrawal(record: WithdrawalRecord, tail: WithdrawalChainProof) {
    record.amount.assertGreaterThan(UInt64.zero, 'withdrawal amount must be non-zero');

    // Collateral check, against the account balance rather than a number we
    // maintain. With `receive: proof()` the balance moves only through these
    // methods, so it *is* the escrowed total — and a precondition on a range
    // rather than an exact value means a concurrent deposit does not
    // invalidate an in-flight release.
    this.account.balance.requireBetween(record.amount, UInt64.MAXINT());

    tail.verify();

    // This record's own link is computed here, not taken from the proof: it is
    // what binds the recipient and amount being paid to the chain.
    const processed = this.processedActionState.getAndRequireEquals();
    const next = applyWithdrawal(processed, record);

    tail.publicOutput.from.assertEquals(next, 'tail does not continue from this withdrawal');
    tail.publicOutput.to.assertEquals(
      this.flareActionState.getAndRequireEquals(),
      'tail does not reach the attested Flare state',
    );

    this.processedActionState.set(next);

    this.send({ to: record.recipient, amount: record.amount });
    this.emitEvent(
      'withdrawal',
      new WithdrawalEvent({
        nonce: record.nonce,
        recipient: record.recipient,
        amount: record.amount,
      }),
    );
  }
}

/**
 * Pack a 20-byte EVM address (as a bigint) into the field representation the
 * zkApp expects. Kept next to the contract so the encoding has exactly one
 * definition on the Mina side.
 */
export function flareRecipientField(address: bigint | string): Field {
  const value = typeof address === 'string' ? BigInt(address) : address;
  if (value < 0n || value >= 1n << BigInt(EVM_ADDRESS_BITS)) {
    throw new Error(`flare recipient out of 160-bit range: ${value}`);
  }
  return Field(value);
}

/** Inverse of `flareRecipientField`, producing a checksum-less 0x address. */
export function flareRecipientHex(value: Field): `0x${string}` {
  return `0x${value.toBigInt().toString(16).padStart(40, '0')}`;
}
