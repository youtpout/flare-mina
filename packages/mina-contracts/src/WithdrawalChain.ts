import { Field, Poseidon, PublicKey, SelfProof, Struct, UInt64, ZkProgram } from 'o1js';

/**
 * A withdrawal, exactly as Flare committed to it.
 *
 * Lives here rather than beside the contract because the chain is what gives
 * the record meaning: these are the fields `burnToMina` folds, in the order it
 * folds them.
 */
export class WithdrawalRecord extends Struct({
  nonce: UInt64,
  recipient: PublicKey,
  amount: UInt64,
}) {}

/**
 * Replays Flare's withdrawal chain, so Mina can tell where a withdrawal sits in it.
 *
 * # What Flare publishes
 *
 * `MinaPortBridge.burnToMina` folds every withdrawal into a running Poseidon
 * commitment — the same shape as a Mina action state:
 *
 *   state <- hashWithPrefix(PREFIX, [state, nonce, recipientX, recipientIsOdd, amount])
 *
 * One field element therefore commits to the entire ordered history, and Flare
 * pays 166,694 gas per withdrawal to maintain it. The alternative, an
 * IndexedMerkleMap insertion, costs 2,786,276 — sixteen times more — and buys
 * Mina nothing it needs.
 *
 * # Why a chain rather than a tree
 *
 * A Merkle tree proves membership in O(log n) and in any order. A chain cannot:
 * reaching a committed state means replaying the exact sequence. That sounds
 * worse and is not, here, for two reasons.
 *
 * One link costs **13 rows** against **14,733** for a single keccak Merkle
 * level. Replaying a thousand withdrawals is cheaper in constraints than
 * climbing one level of a keccak tree.
 *
 * And a chain is append-only, so a newer attested state *contains* every older
 * one. A tree would need the zkApp to remember each published root — impossible
 * in eight field elements of state — while a chain needs exactly one.
 *
 * # How the escrow uses it
 *
 * The zkApp holds two fields: where it has got to (`processedActionState`) and
 * the newest state FDC has attested (`flareActionState`). To release a
 * withdrawal it computes that withdrawal's link itself, then requires a proof
 * that the rest of the chain runs from there to the attested state.
 *
 * That tail is what makes the withdrawal real. Without it a relayer could
 * advance the cursor with a fabricated record; with it, the record must be
 * exactly the next entry Flare committed to, because no other value has a
 * continuation reaching the attested state.
 */

/** Domain separator, matching `WITHDRAWAL_PREFIX_FIELD` in MinaPortBridge.sol. */
export const WITHDRAWAL_PREFIX = 'MinaPortWithdrawV1';

/**
 * Fold one record into a state.
 *
 * The field order is protocol: it has to match `burnToMina` in
 * MinaPortBridge.sol exactly, and both sides are pinned to the same fixed
 * vectors in their respective tests.
 *
 * Exported because the escrow computes the released withdrawal's own link
 * in-circuit rather than taking it from the proof — the record has to be bound
 * to the payment, and the payment happens in the zkApp.
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

/**
 * A stretch of the chain.
 *
 * `from` and `to` are what merges join on. There is no length: a chain segment
 * is identified by its endpoints, and two different sequences cannot share both
 * without a Poseidon collision.
 */
export class ChainSegment extends Struct({
  from: Field,
  to: Field,
}) {}

export const WithdrawalChain = ZkProgram({
  name: 'flare-withdrawal-chain',
  publicOutput: ChainSegment,

  methods: {
    /**
     * The empty segment at a state.
     *
     * Needed when the withdrawal being released is the newest one Flare has
     * committed to — the tail after it is empty, and a released withdrawal must
     * still supply a proof rather than being a special case in the zkApp.
     */
    empty: {
      privateInputs: [Field],
      async method(state: Field) {
        return { publicOutput: new ChainSegment({ from: state, to: state }) };
      },
    },

    /**
     * One link.
     *
     * Takes the state it starts from as an input rather than from a previous
     * proof, so every link in a batch can be proven at the same time — the
     * intermediate states are all known in advance, from Flare's events.
     */
    link: {
      privateInputs: [Field, WithdrawalRecord],
      async method(state: Field, record: WithdrawalRecord) {
        return {
          publicOutput: new ChainSegment({ from: state, to: applyWithdrawal(state, record) }),
        };
      },
    },

    /**
     * Join two segments.
     *
     * The only check is that they meet. Nothing else needs verifying: each side
     * already proved its own hashing.
     */
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
