import { Bytes, Field, Keccak, Provable, SelfProof, Struct, UInt32, ZkProgram } from 'o1js';

/**
 * Proves a leaf is in a keccak Merkle tree (an FDC voting round), by merging
 * one-level segments. One keccak is 14,733 rows against Poseidon's 13, so a
 * level per proof is all that fits; merges make them independent and parallel.
 *
 * Pairs are **sorted**, which is what Flare's trees do and what OpenZeppelin's
 * verifier expects. An earlier version carried a left/right flag instead and
 * would have climbed to a different root from the same path — it passed its own
 * tests, because they only ever checked it against its own convention.
 */

export class Bytes32 extends Bytes(32) {}
export class Bytes64 extends Bytes(64) {}

/** A stretch of the path. Merges chain on bottom/top; height stops a partial climb passing as a full one. */
export class PathSegment extends Struct({
  /** Node this segment starts from. For a full path, the leaf. */
  bottom: Bytes32,
  /** Node this segment reaches. For a full path, the root. */
  top: Bytes32,
  /**
   * Levels climbed. Summed across merges.
   *
   * Nothing checks it, and nothing needs to. A short climb ends on an internal
   * node, and {FdcLeaf} requires `top` to equal the root `SigningPolicyFold`
   * proved was signed — so stopping early would mean an internal node *being*
   * the signed root, which is a collision. The security is in the signed root,
   * not here.
   */
  height: UInt32,
}) {}

/** Byte by byte: `Bytes` has no equality helper, and comparing structs compares witnesses. */
export function assertSameBytes(a: Bytes32, b: Bytes32, message: string): void {
  for (let i = 0; i < 32; i++) {
    a.bytes[i]!.value.assertEquals(b.bytes[i]!.value, message);
  }
}

/**
 * Big-endian bytes as one field element.
 *
 * Sixteen bytes at a time, so the running product cannot approach the modulus:
 * a full 32-byte value would be 256 bits and wrap silently.
 */
function halfToField(bytes: { value: Field }[]): Field {
  return bytes.reduce((acc, b) => acc.mul(256).add(b.value), Field(0));
}

/**
 * True when `a` sorts before `b`, comparing as 256-bit big-endian numbers.
 *
 * Done in halves because a whole 32-byte value does not fit in the field. The
 * high halves decide unless they are equal, in which case the low halves do.
 */
function sortsBefore(a: Bytes32, b: Bytes32) {
  const aHi = halfToField(a.bytes.slice(0, 16));
  const bHi = halfToField(b.bytes.slice(0, 16));
  const aLo = halfToField(a.bytes.slice(16, 32));
  const bLo = halfToField(b.bytes.slice(16, 32));

  return aHi
    .lessThan(bHi)
    .or(aHi.equals(bHi).and(aLo.lessThan(bLo)));
}

export const MerkleInclusion = ZkProgram({
  name: 'flare-merkle-inclusion',
  publicOutput: PathSegment,

  methods: {
    /** One level. Independent of every other, so a whole path proves at once. */
    level: {
      privateInputs: [Bytes32, Bytes32],
      async method(node: Bytes32, sibling: Bytes32) {
        // Sorted, so the path carries no side information — which is also why a
        // sibling cannot be replayed on the wrong side to reach another root.
        const nodeFirst = sortsBefore(node, sibling);
        const left = Provable.if(nodeFirst, Bytes32, node, sibling);
        const right = Provable.if(nodeFirst, Bytes32, sibling, node);

        const parent = Bytes32.from(
          Keccak.ethereum(Bytes64.from([...left.bytes, ...right.bytes])).bytes,
        );

        return { publicOutput: new PathSegment({ bottom: node, top: parent, height: UInt32.one }) };
      },
    },

    /** Join two segments. Only checks they meet — each side proved its own hashing. */
    merge: {
      privateInputs: [SelfProof, SelfProof],
      async method(
        lower: SelfProof<undefined, PathSegment>,
        upper: SelfProof<undefined, PathSegment>,
      ) {
        lower.verify();
        upper.verify();

        const a = lower.publicOutput;
        const b = upper.publicOutput;

        // Contiguity: otherwise unrelated fragments staple into a "path".
        assertSameBytes(a.top, b.bottom, 'segments do not meet');

        return {
          publicOutput: new PathSegment({
            bottom: a.bottom,
            top: b.top,
            height: a.height.add(b.height),
          }),
        };
      },
    },
  },
});

export class MerkleInclusionProof extends ZkProgram.Proof(MerkleInclusion) {}
