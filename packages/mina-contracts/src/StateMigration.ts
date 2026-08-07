import { AccountUpdate, Bool, Field, PublicKey, SmartContract, State, method, state } from 'o1js';

/**
 * A circuit installed for one transaction, to rearrange a zkApp's state.
 *
 * Swapping a verification key does not touch state. So when a contract's
 * `@state` declarations change shape — a field removed, another inserted —
 * every slot after the change reads as the wrong value: the escrow's
 * `flareActionState` would come back as the parity bit of a key that no longer
 * exists. This exists to fix that, and then to be replaced.
 *
 * # What it cannot do
 *
 * Move funds. `send` needs `Permissions.proof()` and this contract has no
 * method that sends, so an account holding an escrow keeps holding it for the
 * whole window. What the authorised key gains, briefly, is the ability to write
 * eight field elements — which is exactly the job and nothing besides.
 *
 * # Why the key is compiled in
 *
 * Reading the admin out of state would mean knowing which slots it sits in,
 * and those differ between the layouts this has to serve. A constant is one
 * definition, visible in the verification key hash, and cannot be misread from
 * state that is by definition mid-rearrangement.
 *
 * Set `MIGRATION_ADMIN` before compiling, install, call {setAll}, then install
 * the real key. Three transactions, and the middle one is the only moment the
 * account is not running its own logic.
 */

/**
 * The key allowed to rewrite state. Read at compile time, so a different key
 * produces a different verification key — installing this circuit is itself
 * the act of naming who may migrate.
 */
export const MIGRATION_ADMIN =
  process.env.MINA_MIGRATION_ADMIN ?? 'B62qq2k9am4nVrsqUSZ1EjUok4awJyuKpzE5bEvZqHUiVo2gYtNJMAY';

export class StateMigration extends SmartContract {
  @state(Field) s0 = State<Field>();
  @state(Field) s1 = State<Field>();
  @state(Field) s2 = State<Field>();
  @state(Field) s3 = State<Field>();
  @state(Field) s4 = State<Field>();
  @state(Field) s5 = State<Field>();
  @state(Field) s6 = State<Field>();
  @state(Field) s7 = State<Field>();

  /**
   * Write all eight slots at once.
   *
   * All eight, not the changed ones: a partial write leaves the caller to
   * remember which slots it skipped, and the whole reason this contract exists
   * is that someone got the slot arithmetic wrong.
   */
  @method async setAll(
    f0: Field,
    f1: Field,
    f2: Field,
    f3: Field,
    f4: Field,
    f5: Field,
    f6: Field,
    f7: Field,
  ) {
    const admin = PublicKey.fromBase58(MIGRATION_ADMIN);
    AccountUpdate.createSigned(admin).body.useFullCommitment = Bool(true);

    // Preconditions on every slot, so the transaction fails rather than racing
    // if anything else touched the account between reading and writing.
    this.s0.getAndRequireEquals();
    this.s1.getAndRequireEquals();
    this.s2.getAndRequireEquals();
    this.s3.getAndRequireEquals();
    this.s4.getAndRequireEquals();
    this.s5.getAndRequireEquals();
    this.s6.getAndRequireEquals();
    this.s7.getAndRequireEquals();

    this.s0.set(f0);
    this.s1.set(f1);
    this.s2.set(f2);
    this.s3.set(f3);
    this.s4.set(f4);
    this.s5.set(f5);
    this.s6.set(f6);
    this.s7.set(f7);
  }
}
