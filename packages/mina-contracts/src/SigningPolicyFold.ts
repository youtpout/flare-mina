import {
  Bytes,
  Crypto,
  Field,
  MerkleWitness,
  Poseidon,
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
 * # How the signer is bound to the policy
 *
 * `policy` is a Poseidon Merkle root over the validator set, and every leaf
 * commits to the whole tuple:
 *
 *   leaf = Poseidon([index, publicKey.x limbs, publicKey.y limbs, weight])
 *
 * A signer therefore cannot be invented, and a real signer's weight cannot be
 * inflated — both live under the same hash. The witness index is checked
 * against the claimed index too, or a prover could prove membership at one
 * position while claiming another, and defeat the ascending-index rule that
 * makes `count` mean distinct signers.
 *
 * # Why this tree is Poseidon and not keccak
 *
 * Flare commits to the same set with `Relay.toSigningPolicyHash`, in keccak,
 * because an EVM has to verify it. Mina's copy only has to be *correct*, not
 * identically encoded — so it is built in Poseidon, at 13 rows a level against
 * keccak's 14,636.
 *
 * Measured, that makes membership **132 rows** beside the 31,814 of the ECDSA
 * verification it accompanies: 0.4%.
 *
 * # What still has to be trusted
 *
 * That the root a consumer compares against really is Flare's validator set.
 * It is a far weaker assumption than attesting individual withdrawals: the
 * signing policy is public, changes once per reward epoch, and anyone can check
 * a published root against `Relay`. A wrong one is visible; a wrong withdrawal
 * attestation is not.
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

/**
 * Merkle depth of the policy tree: 128 leaves.
 *
 * Sized for mainnet, where `maxVoters()` is 100, rather than for Coston2's
 * eight — a testnet-sized tree would mean recompiling every circuit to go live.
 */
export const POLICY_TREE_HEIGHT = 8;

export class PolicyWitness extends MerkleWitness(POLICY_TREE_HEIGHT) {}

/**
 * The leaf committing one entry of the signing policy.
 *
 * Exported because the tree has to be built the same way off-chain; if the two
 * ever disagree, every proof fails rather than some subtly wrong one passing.
 *
 * Both curve coordinates are hashed. Hashing only `x` would let a point and its
 * negation share a leaf, and they are different public keys.
 */
export function policyLeaf(publicKey: Secp256k1, index: UInt32, weight: UInt32): Field {
  return Poseidon.hash([
    index.value,
    ...publicKey.x.toFields(),
    ...publicKey.y.toFields(),
    weight.value,
  ]);
}

export class SignerInput extends Struct({
  publicKey: Secp256k1,
  signature: EcdsaSignature,
  index: UInt32,
  weight: UInt32,
  /** Path proving this entry belongs to the policy the proof names. */
  witness: PolicyWitness,
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

        // The signature is only worth counting if this key is in the policy at
        // this index with this weight.
        signer.witness
          .calculateRoot(policyLeaf(signer.publicKey, signer.index, signer.weight))
          .assertEquals(policy, 'signer is not in the signing policy');

        // And at the index it claims. Without this a prover could prove
        // membership at one position while reporting another, and merge the
        // same signer repeatedly under ascending indices it never held.
        signer.witness
          .calculateIndex()
          .assertEquals(signer.index.value, 'witness is for a different policy index');

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
