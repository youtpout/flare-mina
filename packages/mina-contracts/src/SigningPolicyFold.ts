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
 * Proves enough of Flare's validators signed a root, by merging. One ECDSA is
 * 31,973 rows so the second signature already forces recursion; merging makes
 * leaves independent and depth log(n). Weight, not headcount, is the threshold.
 */

export class Secp256k1 extends createForeignCurve(Crypto.CurveParams.Secp256k1) {}
export class EcdsaSignature extends createEcdsa(Secp256k1) {}
export class Bytes32 extends Bytes(32) {}

/** What a subtree establishes. `message` and `policy` are checked equal on every merge. */
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

/** 128 leaves — sized for mainnet's 100 voters, not Coston2's eight. */
export const POLICY_TREE_HEIGHT = 8;

export class PolicyWitness extends MerkleWitness(POLICY_TREE_HEIGHT) {}

/**
 * One policy entry. Both coordinates are hashed: `x` alone would let a point
 * and its negation share a leaf. Exported because the tree is built off-chain.
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
    /** One signature, independent of every other. */
    single: {
      privateInputs: [Bytes32, Field, SignerInput],
      async method(message: Bytes32, policy: Field, signer: SignerInput) {
        signer.signature
          .verifySignedHash(message, signer.publicKey)
          .assertTrue('invalid validator signature');

        // Only worth counting if this key is in the policy, at this index,
        // with this weight.
        signer.witness
          .calculateRoot(policyLeaf(signer.publicKey, signer.index, signer.weight))
          .assertEquals(policy, 'signer is not in the signing policy');

        // And at the index it claims, or one signer merges with itself under
        // indices it never held.
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

    /** Combine two subtrees. No verification here — both sides did theirs. */
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

        // Same root, or the sum means nothing. Byte by byte: comparing the
        // struct would compare witnesses rather than values.
        for (let i = 0; i < 32; i++) {
          a.message.bytes[i]!.value.assertEquals(
            b.message.bytes[i]!.value,
            'merged proofs disagree on the signed root',
          );
        }
        a.policy.assertEquals(b.policy, 'merged proofs disagree on the signing policy');

        // Strictly ascending, therefore disjoint: else a proof merges with itself.
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
