import {
  Bool,
  Field,
  Poseidon,
  Provable,
  PublicKey,
  SelfProof,
  Struct,
  UInt64,
  ZkProgram,
} from 'o1js';

/**
 * Replays the single Poseidon chain every Flare -> Mina transfer folds into.
 *
 * One chain for every asset, because one per asset meant one FDC attestation
 * and one full proving pass per asset that moved — request, wait for a round,
 * hash 1344 bytes, climb a Merkle path — and four of those per cycle does not
 * keep up with real traffic.
 *
 * # The problem one chain creates, and how it is solved
 *
 * A port administers one token, so it must step over records belonging to the
 * others. But a step over a foreign record is indistinguishable from a step over
 * one of its own, and skipping its own would make that transfer permanently
 * unclaimable — the cursor would be past it.
 *
 * So the segment does the picking. It is examined for one token and reports the
 * *first* record of that token inside it, along with the head immediately after
 * it. A consumer moves its cursor to that head: everything skipped was proven
 * foreign, in circuit, and nothing of its own can be jumped.
 *
 * That also keeps a consumer to a single recursive proof per claim. Two would
 * push a contract method past the wrap domain it fits in, which is not a
 * performance problem but a compile failure.
 */

/** A transfer, exactly as `TransferChain.append` folds it. */
export class TransferRecord extends Struct({
  /** Position in the chain. Monotonic across every asset. */
  index: UInt64,
  /** The asset, as a 160-bit field. FMINA for the escrow rail. */
  token: Field,
  recipient: PublicKey,
  amount: UInt64,
}) {}

/** Domain separator, matching `TRANSFER_PREFIX_FIELD` in TransferChain.sol. */
export const TRANSFER_PREFIX = 'MinaPortTransferV1';

/**
 * Fold one record into a state. Field order is protocol — it must match
 * `append` in TransferChain.sol, and both sides are pinned to the same vectors.
 */
export function applyTransfer(state: Field, record: TransferRecord): Field {
  const { x, isOdd } = record.recipient;
  return Poseidon.hashWithPrefix(TRANSFER_PREFIX, [
    state,
    record.index.value,
    record.token,
    x,
    isOdd.toField(),
    record.amount.value,
  ]);
}

/**
 * A stretch of the chain, examined for one token.
 *
 * Everything after `token` exists so a single-asset consumer can use a shared
 * chain: `found` says the stretch holds at least one of its transfers, and the
 * rest describe the first one and where the cursor lands once it is paid.
 */
export class ChainSegment extends Struct({
  from: Field,
  to: Field,
  /** The token this segment was examined for. Merges require it to match. */
  token: Field,
  /** True if any record in this segment carries `token`. */
  found: Bool,
  /** Recipient of the first such record. Meaningless when `found` is false. */
  firstRecipient: PublicKey,
  /** Its amount. */
  firstAmount: UInt64,
  /** The chain head immediately after it — where a consumer's cursor lands. */
  stateAfterFirst: Field,
}) {}

/** The all-zero tail of a segment that found nothing. Fixed, so merges are deterministic. */
function nothingFound() {
  return {
    found: Bool(false),
    firstRecipient: PublicKey.empty(),
    firstAmount: UInt64.zero,
    stateAfterFirst: Field(0),
  };
}

export const TransferChain = ZkProgram({
  name: 'flare-transfer-chain',
  publicOutput: ChainSegment,

  methods: {
    /** The empty segment, which holds nothing by definition. */
    empty: {
      privateInputs: [Field, Field],
      async method(state: Field, token: Field) {
        return {
          publicOutput: new ChainSegment({
            from: state,
            to: state,
            token,
            ...nothingFound(),
          }),
        };
      },
    },

    /** One link. Takes its start state as input, so a batch proves in parallel. */
    link: {
      privateInputs: [Field, Field, TransferRecord],
      async method(state: Field, token: Field, record: TransferRecord) {
        const to = applyTransfer(state, record);
        const mine = record.token.equals(token);

        return {
          publicOutput: new ChainSegment({
            from: state,
            to,
            token,
            found: mine,
            // Zeroed when the record is not ours, so two segments that skip
            // different foreign records still merge to the same output.
            firstRecipient: Provable.if(mine, PublicKey, record.recipient, PublicKey.empty()),
            firstAmount: Provable.if(mine, UInt64, record.amount, UInt64.zero),
            stateAfterFirst: Provable.if(mine, to, Field(0)),
          }),
        };
      },
    },

    /**
     * Join two segments. The first record of the token is the lower half's if it
     * has one, otherwise the upper half's — which is what makes "first" survive
     * however the range was split.
     */
    merge: {
      privateInputs: [SelfProof, SelfProof],
      async method(
        lower: SelfProof<undefined, ChainSegment>,
        upper: SelfProof<undefined, ChainSegment>,
      ) {
        lower.verify();
        upper.verify();

        const a = lower.publicOutput;
        const b = upper.publicOutput;

        a.to.assertEquals(b.from, 'chain segments do not meet');
        // Without this a caller could merge a segment examined for FXRP with one
        // examined for C2FLR and claim the result holds neither.
        a.token.assertEquals(b.token, 'segments were examined for different tokens');

        return {
          publicOutput: new ChainSegment({
            from: a.from,
            to: b.to,
            token: a.token,
            found: a.found.or(b.found),
            firstRecipient: Provable.if(a.found, PublicKey, a.firstRecipient, b.firstRecipient),
            firstAmount: Provable.if(a.found, UInt64, a.firstAmount, b.firstAmount),
            stateAfterFirst: Provable.if(a.found, a.stateAfterFirst, b.stateAfterFirst),
          }),
        };
      },
    },
  },
});

export class TransferChainProof extends ZkProgram.Proof(TransferChain) {}

/** Pack a 20-byte EVM token address the way a record carries it. */
export function tokenField(address: string): Field {
  return Field(BigInt(address));
}
