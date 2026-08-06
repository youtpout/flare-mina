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
import { RelayMessageProof } from './RelayMessage.js';

/**
 * Proves enough of Flare's validators signed a root, by merging. One ECDSA is
 * 31,973 rows so the second signature already forces recursion; merging makes
 * leaves independent and depth log(n). Weight, not headcount, is the threshold.
 */

export class Secp256k1 extends createForeignCurve(Crypto.CurveParams.Secp256k1) {}
export class EcdsaSignature extends createEcdsa(Secp256k1) {}
export class Bytes32 extends Bytes(32) {}

/**
 * What a subtree establishes. Everything describing the round, plus the policy,
 * is checked equal on every merge.
 *
 * The round is named rather than hashed: an earlier version carried the opaque
 * 32-byte digest, and a consumer had no way to tell which round it belonged to.
 * That was the gap an admin co-signature was standing in for.
 */
export class SignatureSet extends Struct({
  /** Merkle root of the round the validators signed. */
  merkleRoot: Bytes32,
  /** Which protocol's round. FDC is 200; see `FDC_PROTOCOL_ID`. */
  protocolId: UInt32,
  votingRoundId: UInt32,
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
    /**
     * One signature, independent of every other.
     *
     * Takes the relay proof rather than a bare digest, and verifies it here
     * rather than in the consuming contract. Two reasons. It makes the binding
     * unskippable: no caller can name a digest that is not a real round's.
     * And it keeps the contract verifying a single proof type — adding a second
     * one pushed `AssetPort` past a Pickles wrap-domain boundary and it would
     * not compile at all.
     */
    single: {
      privateInputs: [RelayMessageProof, Field, SignerInput],
      async method(relay: RelayMessageProof, policy: Field, signer: SignerInput) {
        relay.verify();

        // What a Flare validator actually signs: the EIP-191 digest over the
        // round's message, recomputed inside `RelayMessage` from the bytes.
        const message = Bytes32.from(relay.publicOutput.digest.bytes);

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
            merkleRoot: relay.publicOutput.merkleRoot,
            protocolId: relay.publicOutput.protocolId,
            votingRoundId: relay.publicOutput.votingRoundId,
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

        // Same round, or the sum means nothing — two halves of a threshold
        // gathered from different rounds is not a threshold. Byte by byte:
        // comparing the struct would compare witnesses rather than values.
        for (let i = 0; i < 32; i++) {
          a.merkleRoot.bytes[i]!.value.assertEquals(
            b.merkleRoot.bytes[i]!.value,
            'merged proofs disagree on the signed root',
          );
        }
        a.protocolId.value.assertEquals(
          b.protocolId.value,
          'merged proofs disagree on the protocol',
        );
        a.votingRoundId.value.assertEquals(
          b.votingRoundId.value,
          'merged proofs disagree on the round',
        );
        a.policy.assertEquals(b.policy, 'merged proofs disagree on the signing policy');

        // Strictly ascending, therefore disjoint: else a proof merges with itself.
        b.minIndex.assertGreaterThan(a.maxIndex, 'merged ranges must be strictly ascending');

        return {
          publicOutput: new SignatureSet({
            merkleRoot: a.merkleRoot,
            protocolId: a.protocolId,
            votingRoundId: a.votingRoundId,
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
