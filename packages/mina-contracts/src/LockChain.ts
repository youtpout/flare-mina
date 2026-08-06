import { Field, Poseidon, PublicKey, SelfProof, Struct, UInt64, ZkProgram } from 'o1js';

/**
 * Replays the Poseidon chain `AssetVault.lock` builds on Flare, so an asset port
 * can tell where a lock sits in it. Same shape as {WithdrawalChain} but a
 * distinct domain and record, so a withdrawal proof can never be replayed as a
 * lock. One chain per token, so a port only ever replays its own asset.
 */

/** A lock, exactly as `_record` folds it. */
export class LockRecord extends Struct({
  claimId: UInt64,
  recipient: PublicKey,
  amount: UInt64,
}) {}

/** Domain separator, matching `LOCK_PREFIX_FIELD` in AssetVault.sol. */
export const LOCK_PREFIX = 'MinaPortLockV1';

/**
 * Fold one lock into a state. Field order is protocol — it must match `_record`
 * in AssetVault.sol, and both sides are pinned to the same fixed vectors.
 */
export function applyLock(state: Field, record: LockRecord): Field {
  const { x, isOdd } = record.recipient;
  return Poseidon.hashWithPrefix(LOCK_PREFIX, [
    state,
    record.claimId.value,
    x,
    isOdd.toField(),
    record.amount.value,
  ]);
}

/** A stretch of a token's lock chain, identified by its endpoints. */
export class LockSegment extends Struct({
  from: Field,
  to: Field,
}) {}

export const LockChain = ZkProgram({
  name: 'flare-lock-chain',
  publicOutput: LockSegment,

  methods: {
    /** The empty segment, so the newest lock still supplies a proof. */
    empty: {
      privateInputs: [Field],
      async method(state: Field) {
        return { publicOutput: new LockSegment({ from: state, to: state }) };
      },
    },

    /** One link. Takes its start state as input, so a batch proves in parallel. */
    link: {
      privateInputs: [Field, LockRecord],
      async method(state: Field, record: LockRecord) {
        return {
          publicOutput: new LockSegment({ from: state, to: applyLock(state, record) }),
        };
      },
    },

    /** Join two segments. Only checks they meet. */
    merge: {
      privateInputs: [SelfProof, SelfProof],
      async method(
        lower: SelfProof<undefined, LockSegment>,
        upper: SelfProof<undefined, LockSegment>,
      ) {
        lower.verify();
        upper.verify();

        lower.publicOutput.to.assertEquals(upper.publicOutput.from, 'lock segments do not meet');

        return {
          publicOutput: new LockSegment({
            from: lower.publicOutput.from,
            to: upper.publicOutput.to,
          }),
        };
      },
    },
  },
});

export class LockChainProof extends ZkProgram.Proof(LockChain) {}
