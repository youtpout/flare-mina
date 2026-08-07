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
import { TransferChainProof } from './TransferChain.js';
import { FdcAttestationProof } from './FdcAttestation.js';
import { FDC_PROTOCOL_ID } from './RelayMessage.js';

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
 * The canonical deposit action. Field order IS the protocol — mirrored by
 * `minaport_core::leaf::DepositLeaf` and `MinaPortEncoding.hashDepositLeaf`.
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

/** A deposit, as a readable log line. ~53 rows; does not touch `actionState`. */
export class DepositEvent extends Struct({
  nonce: UInt64,
  sender: PublicKey,
  flareRecipient: Field,
  amount: UInt64,
}) {}

/** A release, same purpose. */
export class WithdrawalEvent extends Struct({
  recipient: PublicKey,
  amount: UInt64,
}) {}

/**
 * The deposit escrow. Almost no state on purpose: with `receive: proof()` the
 * account balance IS the escrowed total, and the reducer already advances
 * `actionState`, so anything we tracked ourselves could only agree or be a bug.
 */
export class MinaPortBridge extends SmartContract {
  /**
   * Poseidon root over Flare's signing policy, one leaf per validator. Without
   * it a `SigningPolicyFold` proof names any keys with any weights. Occupies
   * the field `lastWithdrawalNonce` held — the chain forces nonce order now.
   */
  @state(Field) signingPolicyRoot = State<Field>();

  /**
   * The Flare `TransferChain` whose events this escrow accepts, as a 160-bit
   * field.
   *
   * Pinned because an attestation proves an event happened, not that it was
   * ours. It is the chain contract rather than the bridge now: every asset folds
   * into one chain, so one emitter and one event signature cover every rail.
   */
  @state(Field) flareChain = State<Field>();

  /**
   * Newest attested state of Flare's withdrawal chain. Append-only, so a newer
   * state contains every older one and publishing strands nothing.
   */
  @state(Field) flareActionState = State<Field>();

  /** How far along Flare's chain this bridge has released. */
  @state(Field) processedActionState = State<Field>();

  /** Signing weight a root must carry. Deployment state, since the number belongs to the network. */
  @state(UInt64) requiredWeight = State<UInt64>();

  /**
   * FMINA on Flare, as a 160-bit field. The shared chain carries every asset, so
   * this is what tells a record of ours from one belonging to a wrapped-asset
   * port — the escrow must never pay out against an FXRP lock.
   */
  @state(Field) token = State<Field>();

  /** Admin key. Only privilege is rotating the signing policy; it cannot move funds. */
  @state(PublicKey) admin = State<PublicKey>();

  reducer = Reducer({ actionType: DepositAction });

  override events = {
    deposit: DepositEvent,
    withdrawal: WithdrawalEvent,
  };

  /** Keys are written after `super.deploy` so the contract is never live with an unset admin. */
  override async deploy(
    args: DeployArgs & {
      admin: PublicKey;
      /** The Flare `TransferChain`, as a 160-bit field. */
      flareChain: Field;
      /** FMINA on Flare, as a 160-bit field. */
      token: Field;
      /** Poseidon root over Flare's validator set. Zero accepts no proof. */
      signingPolicyRoot?: Field;
      /** Signing weight a Flare root must carry. Zero accepts any. */
      requiredWeight?: UInt64;
    },
  ) {
    await super.deploy(args);
    this.admin.set(args.admin);
    this.flareChain.set(args.flareChain);
    this.token.set(args.token);
    this.requiredWeight.set(args.requiredWeight ?? UInt64.zero);
    this.signingPolicyRoot.set(args.signingPolicyRoot ?? Field(0));
  }

  override init() {
    super.init();
    // Zero is the empty chain on both sides: Flare's `TransferChain.head`
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
      // Upgradable by signature from the zkApp's own key.
      //
      // Every circuit change produces a new verification key. With the key
      // locked, shipping one means a fresh zkApp at a fresh address, and the
      // MINA escrowed at the old one stays there unreachable — which has
      // already cost this project funds.
      //
      // Signature rather than proof, deliberately. A proof-gated upgrade needs
      // an `upgrade` method, which is a circuit that must itself be deployed
      // before it can ever be used — so it cannot fix the deployment that
      // shipped without it, which is exactly when an upgrade is wanted. A
      // signature works from the first block and costs no rows.
      //
      // The concession is real and belongs in docs/threat-model.md rather than
      // in a footnote: whoever holds this key can install a circuit that pays
      // the escrow to itself, so it is as powerful as the collateral.
      setVerificationKey: Permissions.VerificationKey.signature(),
      setPermissions: Permissions.impossible(),
    });
  }

  /**
   * Rotate the signing-policy root. Mandatory, not administrative: Flare's
   * validator set changes every reward epoch — 6h on Coston2, 3.5 days on
   * mainnet — and a fixed root would stop accepting proofs at the first change.
   */
  @method async setSigningPolicyRoot(root: Field) {
    const admin = this.admin.getAndRequireEquals();
    const adminUpdate = AccountUpdate.createSigned(admin);
    adminUpdate.body.useFullCommitment = Bool(true);

    this.signingPolicyRoot.getAndRequireEquals();
    this.signingPolicyRoot.set(root);
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
   * Accept a new chain state, read out of an attested Flare event.
   *
   * Nothing here is asserted by a key. The proof establishes that enough of
   * Flare's validator set signed an FDC round, that the attestation response
   * sits under that round's root, and that the state below was read from the
   * `Transfer` event inside it.
   *
   * Separate from releasing because establishing a state costs ECDSA and
   * keccak, and is identical across the whole batch it covers.
   */
  @method async publishFlareActionState(attestation: FdcAttestationProof) {
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

    // And the event has to have come from our bridge.
    attested.emitter.assertEquals(
      this.flareChain.getAndRequireEquals(),
      'the event came from another contract',
    );

    this.flareActionState.getAndRequireEquals();
    this.flareActionState.set(attested.actionState);
  }

  /**
   * Release the next withdrawal.
   *
   * Nothing is passed in but the segment: recipient and amount come out of the
   * proof, which spans the cursor to the attested head and names the first FMINA
   * record in that range. Records of other assets in between are stepped over,
   * proven foreign in circuit — the caller does not get to choose what to skip.
   *
   * Serialised: it advances the cursor, so two releases in one block conflict.
   */
  @method async releaseWithdrawal(segment: TransferChainProof) {
    segment.verify();
    const found = segment.publicOutput;

    found.token.assertEquals(
      this.token.getAndRequireEquals(),
      'segment was examined for another asset',
    );
    found.from.assertEquals(
      this.processedActionState.getAndRequireEquals(),
      'segment does not start at the cursor',
    );
    found.to.assertEquals(
      this.flareActionState.getAndRequireEquals(),
      'segment does not reach the attested Flare state',
    );
    found.found.assertTrue('no withdrawal to release');
    found.firstAmount.assertGreaterThan(UInt64.zero, 'withdrawal amount must be non-zero');

    // Collateral check, against the account balance rather than a number we
    // maintain. With `receive: proof()` the balance moves only through these
    // methods, so it *is* the escrowed total — and a precondition on a range
    // rather than an exact value means a concurrent deposit does not
    // invalidate an in-flight release.
    this.account.balance.requireBetween(found.firstAmount, UInt64.MAXINT());

    this.processedActionState.set(found.stateAfterFirst);

    this.send({ to: found.firstRecipient, amount: found.firstAmount });
    this.emitEvent(
      'withdrawal',
      new WithdrawalEvent({
        recipient: found.firstRecipient,
        amount: found.firstAmount,
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
