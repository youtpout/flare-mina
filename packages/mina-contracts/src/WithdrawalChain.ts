import { Field, Poseidon, PublicKey, SelfProof, Struct, UInt64, ZkProgram } from 'o1js';

/**
 * Replays the Poseidon chain `burnToMina` builds on Flare, so the escrow can
 * tell where a withdrawal sits in it. A link is 13 rows against 14,733 for a
 * keccak Merkle level, and a chain is append-only so one field commits to all.
 */

/** A withdrawal, exactly as `burnToMina` folds it. */
export class WithdrawalRecord extends Struct({
  nonce: UInt64,
  recipient: PublicKey,
  amount: UInt64,
}) {}


/** Domain separator, matching `WITHDRAWAL_PREFIX_FIELD` in MinaPortBridge.sol. */
export const WITHDRAWAL_PREFIX = 'MinaPortWithdrawV1';

/**
 * Fold one record into a state. Field order is protocol — it must match
 * `burnToMina` in MinaPortBridge.sol, and both sides are pinned to the same
 * fixed vectors. The escrow calls this itself to bind the payment it makes.
 */
export function applyWithdrawal(state: Field, record: WithdrawalRecord): Field {
  const { x, isOdd } = record.recipient;
  return Poseidon.hashWithPrefix(WITHDRAWAL_PREFIX, [
    state,
    record.nonce.value,
    x,
    isOdd.toField(),
    record.amount.value,
  ]);
}

/** A stretch of the chain, identified by its endpoints. */
export class ChainSegment extends Struct({
  from: Field,
  to: Field,
}) {}

export const WithdrawalChain = ZkProgram({
  name: 'flare-withdrawal-chain',
  publicOutput: ChainSegment,

  methods: {
    /** The empty segment, so the newest withdrawal still supplies a proof. */
    empty: {
      privateInputs: [Field],
      async method(state: Field) {
        return { publicOutput: new ChainSegment({ from: state, to: state }) };
      },
    },

    /** One link. Takes its start state as input, so a batch proves in parallel. */
    link: {
      privateInputs: [Field, WithdrawalRecord],
      async method(state: Field, record: WithdrawalRecord) {
        return {
          publicOutput: new ChainSegment({ from: state, to: applyWithdrawal(state, record) }),
        };
      },
    },

    /** Join two segments. Only checks they meet. */
    merge: {
      privateInputs: [SelfProof, SelfProof],
      async method(
        lower: SelfProof<undefined, ChainSegment>,
        upper: SelfProof<undefined, ChainSegment>,
      ) {
        lower.verify();
        upper.verify();

        lower.publicOutput.to.assertEquals(
          upper.publicOutput.from,
          'chain segments do not meet',
        );

        return {
          publicOutput: new ChainSegment({
            from: lower.publicOutput.from,
            to: upper.publicOutput.to,
          }),
        };
      },
    },
  },
});

export class WithdrawalChainProof extends ZkProgram.Proof(WithdrawalChain) {}
