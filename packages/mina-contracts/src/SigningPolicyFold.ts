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
 * Folds Flare validator signatures until enough of them agree.
 *
 * # What this replaces
 *
 * Today the Flare -> Mina return path trusts one attestor key to say a burn
 * happened — GAP 2 in docs/threat-model.md. This is the machinery that removes
 * it: Flare's Relay publishes Merkle roots signed by its validator set, so
 * proving a Flare event on Mina is signature verification rather than
 * recursive proof verification. That is what makes this direction tractable at
 * all, and it is the reason the asymmetry in the design exists.
 *
 * # Why recursion is not optional
 *
 * One secp256k1 verification costs **31,812 rows**, measured. Mina's proof
 * domain caps at 65,536, so two signatures do not fit in one proof and the
 * second one already forces recursion. Depth is the only thing that changes
 * between networks:
 *
 * | network  | voters | signatures past threshold | steps | proving |
 * |----------|--------|---------------------------|-------|---------|
 * | Coston2  | 8      | ~5                        | ~5    | ~18 s   |
 * | mainnet  | ≤100   | ~50                       | ~50   | ~3 min  |
 *
 * Nothing here is written for either number. The fold is generic in depth and
 * the consumer decides when it has seen enough, which is the only way a
 * hackathon-sized threshold does not become a mainnet-sized bug.
 *
 * # Why the signer index is in the accumulator
 *
 * Counting signatures is worthless without distinctness: the same signature
 * folded five times would otherwise read as five signers. Each step therefore
 * asserts its signer sits at a strictly greater index in the signing policy
 * than the previous one, which makes duplicates impossible and, as a side
 * effect, fixes the fold order.
 *
 * Weight is accumulated alongside the count because Flare's security is
 * weight-based, not headcount-based. A consumer that only checks the count is
 * making a weaker statement than the one Flare makes, and should know it.
 */

export class Secp256k1 extends createForeignCurve(Crypto.CurveParams.Secp256k1) {}
export class EcdsaSignature extends createEcdsa(Secp256k1) {}
export class Bytes32 extends Bytes(32) {}

/**
 * What a fold has established so far.
 *
 * `message` and `policy` are carried through unchanged so that every step is
 * pinned to the same root and the same validator set — folding two proofs about
 * different roots must be impossible, not merely unlikely.
 */
export class FoldState extends Struct({
  /** The Merkle root the validators signed. */
  message: Bytes32,
  /** Commitment to the signing policy the signers must belong to. */
  policy: Field,
  /** How many distinct signatures have been verified. */
  count: UInt32,
  /** Their weights, summed. This is what Flare's threshold is expressed in. */
  weight: UInt32,
  /**
   * Index of the last signer in the policy. Strictly increasing, which is what
   * makes `count` mean "distinct signers" rather than "verifications run".
   */
  lastIndex: UInt32,
}) {}

/**
 * One signer's contribution.
 *
 * `index` and `weight` come from the signing policy. Binding them to `policy`
 * is the consumer's job — see the note on `SigningPolicyFold` — because how a
 * policy is committed to depends on how it was fetched, and this program should
 * not care.
 */
export class SignerInput extends Struct({
  publicKey: Secp256k1,
  signature: EcdsaSignature,
  index: UInt32,
  weight: UInt32,
}) {}

export const SigningPolicyFold = ZkProgram({
  name: 'flare-signing-policy-fold',
  publicOutput: FoldState,

  methods: {
    /**
     * The first signature.
     *
     * Starts the chain rather than taking an empty accumulator, so a fold
     * always contains at least one verification and `count` can never be zero
     * for a valid proof.
     */
    base: {
      privateInputs: [Bytes32, Field, SignerInput],
      async method(message: Bytes32, policy: Field, signer: SignerInput) {
        signer.signature
          .verifySignedHash(message, signer.publicKey)
          .assertTrue('invalid validator signature');

        return {
          publicOutput: new FoldState({
            message,
            policy,
            count: UInt32.one,
            weight: signer.weight,
            lastIndex: signer.index,
          }),
        };
      },
    },

    /**
     * One more signature on top of an existing fold.
     *
     * The previous proof is verified recursively, so a chain of these is a
     * single statement: *n distinct members of this policy signed this root,
     * with this much weight between them.*
     */
    step: {
      privateInputs: [SelfProof, SignerInput],
      async method(previous: SelfProof<undefined, FoldState>, signer: SignerInput) {
        previous.verify();
        const state = previous.publicOutput;

        signer.signature
          .verifySignedHash(state.message, signer.publicKey)
          .assertTrue('invalid validator signature');

        // Strictly greater, not merely different: it rules out duplicates with
        // one comparison instead of a membership set, and pins the order.
        signer.index.assertGreaterThan(state.lastIndex, 'signers must be strictly ordered');

        return {
          publicOutput: new FoldState({
            message: state.message,
            policy: state.policy,
            count: state.count.add(1),
            weight: state.weight.add(signer.weight),
            lastIndex: signer.index,
          }),
        };
      },
    },
  },
});

export class SigningPolicyProof extends ZkProgram.Proof(SigningPolicyFold) {}
