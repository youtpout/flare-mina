import {
  Bytes,
  Crypto,
  Field,
  SelfProof,
  Struct,
  UInt32,
  ZkProgram,
  createEcdsa,
  createForeignCurve,
} from 'o1js';

/**
 * Proves that enough of Flare's validators signed a root, by merging.
 *
 * # What this replaces
 *
 * The Flare -> Mina return path trusts one attestor key to say a burn
 * happened — GAP 2 in docs/threat-model.md. This is the machinery that removes
 * it: Flare's Relay publishes Merkle roots signed by its validator set, so
 * proving a Flare event on Mina is signature verification rather than
 * recursive proof verification. That is the whole reason this direction is
 * tractable, and why the design is asymmetric.
 *
 * # Why merge rather than fold
 *
 * A linear chain — verify one, then another on top — makes every signature wait
 * for the one before it. Fifty signatures is fifty sequential proofs.
 *
 * Merging makes the leaves independent: every `single` proof stands alone and
 * they can all be produced at once, then combined pairwise. Depth goes from
 * *n* to *log n*, and the wall-clock from the sum of the proofs to roughly the
 * slowest one plus a handful of merges.
 *
 * It also removes the conditional loop the chain needed for short inputs. Each
 * proof does exactly one thing, and composition is where the structure lives.
 *
 * # Why recursion is not optional either way
 *
 * One secp256k1 verification is **31,812 rows**, measured, against a 65,536-row
 * domain. Two do not fit, so the *second* signature already forces recursion.
 * Only the depth changes between networks:
 *
 * | network  | voters | signatures past threshold | merge depth |
 * |----------|--------|---------------------------|-------------|
 * | Coston2  | 8      | ~5                        | 3           |
 * | mainnet  | ≤100   | ~50                       | 6           |
 *
 * Nothing here is written for either number, and the consumer decides when it
 * has seen enough — a contract can require 2 for a demo and the real weight
 * threshold in production without this changing.
 *
 * # Why the index range is in the state
 *
 * Counting signatures is worthless without distinctness: the same signature
 * merged five times would otherwise read as five signers. Each state therefore
 * carries the range of policy indices it covers, and a merge asserts the left
 * range ends strictly before the right one begins. Disjointness follows, and
 * with it the meaning of `count`.
 *
 * Weight is accumulated alongside because Flare's threshold is expressed in
 * weight, not headcount. A consumer checking only `count` is making a weaker
 * claim than Flare does.
 *
 * # NOT YET SOUND: the signer is not bound to the policy
 *
 * `policy` is carried but nothing constrains `(index, publicKey, weight)` to
 * belong to it, so a prover can name any key and claim any weight. What this
 * proves today is *"n valid ECDSA signatures over this message, at distinct
 * ascending indices"* — real, and the expensive part, but not yet *"Flare's
 * signing policy approved this root"*.
 *
 * Closing it means proving membership against `Relay.toSigningPolicyHash`,
 * which is keccak — and keccak costs 14,636 rows against Poseidon's 13. That
 * is the next piece, and it must land before this replaces the attestor.
 */

export class Secp256k1 extends createForeignCurve(Crypto.CurveParams.Secp256k1) {}
export class EcdsaSignature extends createEcdsa(Secp256k1) {}
export class Bytes32 extends Bytes(32) {}

/**
 * What a subtree of signatures establishes.
 *
 * `message` and `policy` are carried unchanged and checked equal on every
 * merge, so two proofs about different roots cannot be combined — that has to
 * be impossible, not merely unlikely.
 */
export class SignatureSet extends Struct({
  /** The Merkle root the validators signed. */
  message: Bytes32,
  /** Commitment to the signing policy the signers must belong to. */
  policy: Field,
  /** Distinct signatures verified beneath this proof. */
  count: UInt32,
  /** Their weights, summed. What Flare's threshold is expressed in. */
  weight: UInt32,
  /** Lowest policy index covered. */
  minIndex: UInt32,
  /** Highest policy index covered. Merges require strictly ascending ranges. */
  maxIndex: UInt32,
}) {}

export class SignerInput extends Struct({
  publicKey: Secp256k1,
  signature: EcdsaSignature,
  index: UInt32,
  weight: UInt32,
}) {}

export const SigningPolicyFold = ZkProgram({
  name: 'flare-signing-policy',
  publicOutput: SignatureSet,

  methods: {
    /**
     * One signature, standing alone.
     *
     * Independent of every other, which is the point: all of them can be
     * proven at the same time.
     */
    single: {
      privateInputs: [Bytes32, Field, SignerInput],
      async method(message: Bytes32, policy: Field, signer: SignerInput) {
        signer.signature
          .verifySignedHash(message, signer.publicKey)
          .assertTrue('invalid validator signature');

        return {
          publicOutput: new SignatureSet({
            message,
            policy,
            count: UInt32.one,
            weight: signer.weight,
            minIndex: signer.index,
            maxIndex: signer.index,
          }),
        };
      },
    },

    /**
     * Combine two subtrees into one.
     *
     * No signature verification here — both sides already did theirs. This only
     * checks they are about the same thing and that their index ranges do not
     * overlap, which is what keeps `count` honest.
     */
    merge: {
      privateInputs: [SelfProof, SelfProof],
      async method(
        left: SelfProof<undefined, SignatureSet>,
        right: SelfProof<undefined, SignatureSet>,
      ) {
        left.verify();
        right.verify();

        const a = left.publicOutput;
        const b = right.publicOutput;

        // Same root and same validator set, or the sum means nothing.
        // Byte by byte: `Bytes` has no equality helper, and comparing the
        // struct wholesale would compare witnesses rather than values.
        for (let i = 0; i < 32; i++) {
          a.message.bytes[i]!.value.assertEquals(
            b.message.bytes[i]!.value,
            'merged proofs disagree on the signed root',
          );
        }
        a.policy.assertEquals(b.policy, 'merged proofs disagree on the signing policy');

        // Strictly ascending and therefore disjoint: without this, merging a
        // proof with itself would double a count and a weight.
        b.minIndex.assertGreaterThan(a.maxIndex, 'merged ranges must be strictly ascending');

        return {
          publicOutput: new SignatureSet({
            message: a.message,
            policy: a.policy,
            count: a.count.add(b.count),
            weight: a.weight.add(b.weight),
            minIndex: a.minIndex,
            maxIndex: b.maxIndex,
          }),
        };
      },
    },
  },
});

export class SigningPolicyProof extends ZkProgram.Proof(SigningPolicyFold) {}
