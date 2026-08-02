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
import { DEPOSIT_DOMAIN, EVM_ADDRESS_BITS, WITHDRAWAL_DOMAIN } from './constants.js';

/**
 * MinaPort bridge zkApp — the Mina side of the MINA <-> wMINA bridge.
 *
 * Responsibilities:
 *   - Mina -> Flare: escrow native MINA and dispatch a canonical deposit action
 *     that the prover later aggregates into a batch settled on Flare.
 *   - Flare -> Mina: release escrowed MINA against a proven `WithdrawToMina`
 *     event (see the trust note on `releaseWithdrawal`).
 *
 * Collateral invariant: `lockedNanomina` is the exact amount of MINA held by
 * this account on behalf of bridged users, and equals the wMINA total supply on
 * Flare once every in-flight batch has settled.
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

/** A withdrawal proven to have happened on Flare. */
export class WithdrawalRecord extends Struct({
  nonce: UInt64,
  recipient: PublicKey,
  amount: UInt64,
}) {
  hash(): Field {
    const { x, isOdd } = this.recipient;
    return Poseidon.hash([
      WITHDRAWAL_DOMAIN,
      this.nonce.value,
      x,
      isOdd.toField(),
      this.amount.value,
    ]);
  }
}

export class MinaPortBridge extends SmartContract {
  /** Hash-chain commitment over every deposit dispatched so far. */
  @state(Field) depositActionState = State<Field>();

  /** Next deposit nonce. Strictly monotonic; makes every deposit leaf unique. */
  @state(UInt64) nextDepositNonce = State<UInt64>();

  /** Native MINA currently escrowed on behalf of bridged users, in nanomina. */
  @state(UInt64) lockedNanomina = State<UInt64>();

  /**
   * Highest Flare withdrawal nonce released so far.
   *
   * Withdrawals must be released in strictly increasing nonce order, which
   * gives replay protection in O(1) state instead of an unbounded set. The
   * relayer is responsible for submitting them in order; it cannot skip one
   * without permanently stranding it (see docs/threat-model.md).
   */
  @state(UInt64) lastWithdrawalNonce = State<UInt64>();

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
   * Administrative key, fixed at deployment.
   *
   * The only privilege it holds is rotating `withdrawalAttestor`. It cannot
   * move funds, mint, or edit any accounting state — those are reachable only
   * through proof-authorised methods.
   */
  @state(PublicKey) admin = State<PublicKey>();

  reducer = Reducer({ actionType: DepositAction });

  /**
   * Deploy with an explicit admin and attestor.
   *
   * `super.deploy` runs `init()` (zeroing the accounting state and locking down
   * permissions); the two keys are written afterwards so the contract is never
   * live with an unset admin that a third party could claim.
   */
  override async deploy(args: DeployArgs & { admin: PublicKey; withdrawalAttestor: PublicKey }) {
    await super.deploy(args);
    this.admin.set(args.admin);
    this.withdrawalAttestor.set(args.withdrawalAttestor);
  }

  override init() {
    super.init();
    this.depositActionState.set(Reducer.initialActionState);
    this.nextDepositNonce.set(UInt64.zero);
    this.lockedNanomina.set(UInt64.zero);
    this.lastWithdrawalNonce.set(UInt64.zero);

    this.account.permissions.set({
      ...Permissions.default(),
      // Balance may only move through this contract's own methods.
      send: Permissions.proof(),
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
   * @param expectedNonce the nonce the caller believes it will receive. Asserted
   *   against contract state so the caller can precompute its deposit leaf (and
   *   therefore its Flare claim) before submitting, while the contract remains
   *   the sole authority on nonce assignment. A replayed transaction fails this
   *   assertion, which is what makes duplicate deposits impossible.
   * @param flareRecipient the Flare address entitled to the minted wMINA,
   *   big-endian in the low 160 bits of a field element.
   * @param amount amount to lock, in nanomina. Must be non-zero.
   */
  @method async deposit(expectedNonce: UInt64, flareRecipient: Field, amount: UInt64) {
    amount.assertGreaterThan(UInt64.zero, 'deposit amount must be non-zero');
    new FlareAddress({ value: flareRecipient }).assertValid();

    const nonce = this.nextDepositNonce.getAndRequireEquals();
    // `UInt64.assertEquals` takes no message in this o1js version, and its
    // default reads `Field.assertEquals(): 1 != 0` — which tells a user nothing
    // about what they got wrong. Going through `equals().assertTrue()` keeps
    // the message.
    nonce.equals(expectedNonce).assertTrue('unexpected deposit nonce');

    // Pull the funds. `createSigned` forces the sender to authorise this exact
    // account update, so the bridge can never move funds it was not given.
    const sender = this.sender.getAndRequireSignature();
    const senderUpdate = AccountUpdate.createSigned(sender);
    senderUpdate.send({ to: this.address, amount });

    const locked = this.lockedNanomina.getAndRequireEquals();
    this.lockedNanomina.set(locked.add(amount));
    this.nextDepositNonce.set(nonce.add(UInt64.one));

    const action = new DepositAction({
      nonce,
      senderX: sender.x,
      senderIsOdd: sender.isOdd,
      flareRecipient,
      amount,
    });
    this.reducer.dispatch(action);

    // Extend the local hash chain. This is the value the SP1 guest proves a
    // transition of, and the value the Flare bridge tracks as
    // `currentMinaActionState`.
    const previous = this.depositActionState.getAndRequireEquals();
    this.depositActionState.set(Poseidon.hash([previous, action.hash()]));
  }

  /**
   * Release escrowed MINA for a withdrawal that was proven on Flare.
   *
   * HACKATHON TRUST ASSUMPTION: authorisation is a signature from
   * `withdrawalAttestor` rather than an in-circuit proof of the Flare Relay
   * signing policy. Everything else — nonce monotonicity, amount, recipient
   * binding, collateral accounting — is enforced by the circuit and does not
   * change when the attestor is replaced by a real proof.
   */
  @method async releaseWithdrawal(record: WithdrawalRecord) {
    record.amount.assertGreaterThan(UInt64.zero, 'withdrawal amount must be non-zero');

    const lastNonce = this.lastWithdrawalNonce.getAndRequireEquals();
    record.nonce.assertGreaterThan(lastNonce, 'withdrawal nonce must be strictly increasing');

    const locked = this.lockedNanomina.getAndRequireEquals();
    record.amount.assertLessThanOrEqual(locked, 'withdrawal exceeds escrowed collateral');

    // The attestor must co-sign this transaction.
    const attestor = this.withdrawalAttestor.getAndRequireEquals();
    const attestorUpdate = AccountUpdate.createSigned(attestor);
    attestorUpdate.body.useFullCommitment = Bool(true);

    this.lastWithdrawalNonce.set(record.nonce);
    this.lockedNanomina.set(locked.sub(record.amount));

    this.send({ to: record.recipient, amount: record.amount });
  }

  /**
   * Read-only helper used by tests and by the prover's fixture generator to
   * derive the expected action-state transition for a batch of deposits.
   */
  static advanceActionState(previous: Field, actions: DepositAction[]): Field {
    return actions.reduce((state, action) => Poseidon.hash([state, action.hash()]), previous);
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
