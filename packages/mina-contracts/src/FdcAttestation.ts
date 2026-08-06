import { Bytes, Field, Keccak, Struct, UInt32, ZkProgram } from 'o1js';
import { Bytes32, MerkleInclusionProof, assertSameBytes } from './MerkleInclusion.js';
import { SigningPolicyProof } from './SigningPolicyFold.js';

/**
 * The last link: an action state that no key asserts.
 *
 * `SigningPolicyFold` already proves that enough of Flare's validator set signed
 * a particular FDC round, and names that round's Merkle root. This proves that a
 * given attestation response sits under that root, and reads the bridge's action
 * state out of it. The result is a state the validators have effectively signed,
 * so the contract needs no attestor co-signature — that key was standing in for
 * exactly this proof.
 *
 * # Why it is two programs
 *
 * A contract method may verify one proof comfortably; two pushed `AssetPort`
 * past a Pickles wrap-domain boundary. So the proofs nest instead of stacking,
 * and the contract sees one proof carrying everything.
 *
 * But the nesting cannot all happen in one circuit either: hashing 1344 bytes
 * is 149,399 rows, and combining that with *two* recursive verifications asks
 * for a wrap domain of 16 when the highest reachable is 15. So the work splits
 * by weight — {FdcLeaf} carries the rows and one proof, {FdcAttestation} joins
 * two proofs and carries almost no rows. Neither exceeds what Pickles allows.
 *
 * `numChunks` and `overrideWrapDomain` belong on the declaration; `compile()`
 * does not accept them, and passing them there is silently ignored.
 */

/** A trimmed `EVMTransaction` response: `provideInput: false`, one `logIndices`. */
export const RESPONSE_BYTES = 1344;

export class AttestationResponse extends Bytes(RESPONSE_BYTES) {}

/**
 * Where the fields sit in a trimmed response, in 32-byte words.
 *
 * Stable only because the request is trimmed, so the shape is checked rather
 * than assumed — a wider response moves every word, and reading these positions
 * would yield a plausible number from the wrong place. Mirrored by
 * `packages/shared/src/fdcResponse.ts`, which the relayer uses to decide what
 * to prove before paying to prove it.
 */
const WORD = { emitter: 28, topic0: 33, actionState: 41 } as const;

/** What hashing the response establishes, before the signatures are considered. */
export class AttestedLeaf extends Struct({
  /** Root the inclusion path reached. Matched against the signed round. */
  merkleRoot: Bytes32,
  actionState: Field,
  emitter: Field,
  topic0: Bytes32,
}) {}

export class AttestedState extends Struct({
  /** Read out of the attested event, not supplied by a caller. */
  actionState: Field,
  /** Contract that emitted it, in the low 20 bytes. The consumer pins this. */
  emitter: Field,
  /** Event signature, so one rail's event cannot settle the other's. */
  topic0: Bytes32,
  /** Carried through from the policy proof, for the consumer to check. */
  policy: Field,
  weight: UInt32,
  protocolId: UInt32,
  votingRoundId: UInt32,
}) {}

/** Big-endian bytes of one word as a field. Sixteen at a time; see below. */
function halfToField(bytes: { value: Field }[]): Field {
  return bytes.reduce((acc, b) => acc.mul(256).add(b.value), Field(0));
}

function wordAt(response: AttestationResponse, index: number) {
  return response.bytes.slice(index * 32, (index + 1) * 32);
}

/**
 * The heavy half: hash the response, read the event, reach a root.
 *
 * Says nothing about who signed that root — {FdcAttestation} does that.
 */
export const FdcLeaf = ZkProgram({
  name: 'fdc-leaf',
  publicOutput: AttestedLeaf,

  // 149,399 rows needs four chunks, and four needs wrap domain 2. Three
  // compiles and then fails to prove with `Expected 4 <= 3`.
  numChunks: 4,
  overrideWrapDomain: 2,

  methods: {
    read: {
      privateInputs: [AttestationResponse, MerkleInclusionProof],
      async method(response: AttestationResponse, inclusion: MerkleInclusionProof) {
        inclusion.verify();

        // The leaf an FDC round commits to: keccak over the response verbatim.
        // `ethereum`, not `nistSha3` — Ethereum froze Keccak before NIST changed
        // the padding, and the two disagree on every input.
        const leaf = Bytes32.from(Keccak.ethereum(response).bytes);
        assertSameBytes(inclusion.publicOutput.bottom, leaf, 'the path is not for this response');

        // The action state, read from the attested bytes.
        //
        // Reconstructed in halves because 32 bytes is 256 bits and would wrap
        // the field silently. The top byte is held below 0x40, which bounds the
        // value under 2^254 and therefore under the Pallas modulus — so this is
        // the number Flare wrote, not a wrapped alias of it.
        const stateBytes = wordAt(response, WORD.actionState);
        stateBytes[0]!.value.assertLessThan(Field(0x40), 'action state is not a field element');
        const actionState = halfToField(stateBytes.slice(0, 16))
          .mul(Field(2n ** 128n))
          .add(halfToField(stateBytes.slice(16, 32)));

        return {
          publicOutput: new AttestedLeaf({
            merkleRoot: inclusion.publicOutput.top,
            actionState,
            // The emitter fits in 160 bits, so one half is enough.
            emitter: halfToField(wordAt(response, WORD.emitter).slice(12, 32)),
            topic0: Bytes32.from(wordAt(response, WORD.topic0)),
          }),
        };
      },
    },
  },
});

export class FdcLeafProof extends ZkProgram.Proof(FdcLeaf) {}

/**
 * The light half: the root that was reached is the root that was signed.
 *
 * Two recursive verifications and barely any rows of its own, which is exactly
 * the shape Pickles is happy with.
 */
export const FdcAttestation = ZkProgram({
  name: 'fdc-attestation',
  publicOutput: AttestedState,

  methods: {
    attest: {
      privateInputs: [FdcLeafProof, SigningPolicyProof],
      async method(leaf: FdcLeafProof, policy: SigningPolicyProof) {
        leaf.verify();
        policy.verify();

        assertSameBytes(
          leaf.publicOutput.merkleRoot,
          policy.publicOutput.merkleRoot,
          'the path does not reach the signed round root',
        );

        return {
          publicOutput: new AttestedState({
            actionState: leaf.publicOutput.actionState,
            emitter: leaf.publicOutput.emitter,
            topic0: leaf.publicOutput.topic0,
            policy: policy.publicOutput.policy,
            weight: policy.publicOutput.weight,
            protocolId: policy.publicOutput.protocolId,
            votingRoundId: policy.publicOutput.votingRoundId,
          }),
        };
      },
    },
  },
});

export class FdcAttestationProof extends ZkProgram.Proof(FdcAttestation) {}

/** Pack a 20-byte EVM address the way `emitter` is exposed. */
export function emitterField(address: string): Field {
  return Field(BigInt(address));
}
