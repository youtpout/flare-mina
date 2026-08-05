import { Bool, Bytes, Keccak, Provable, SelfProof, Struct, UInt32, ZkProgram } from 'o1js';

/**
 * Proves a leaf is in a keccak Merkle tree (an FDC voting round), by merging
 * one-level segments. One keccak is 14,733 rows against Poseidon's 13, so a
 * level per proof is all that fits; merges make them independent and parallel.
 */

export class Bytes32 extends Bytes(32) {}
export class Bytes64 extends Bytes(64) {}

/** A stretch of the path. Merges chain on bottom/top; height stops a partial climb passing as a full one. */
export class PathSegment extends Struct({
  /** Node this segment starts from. For a full path, the leaf. */
  bottom: Bytes32,
  /** Node this segment reaches. For a full path, the root. */
  top: Bytes32,
  /** Levels climbed. Summed across merges; checked by the consumer. */
  height: UInt32,
}) {}

/** The other child at one level, and which side it sits on. */
export class Sibling extends Struct({
  value: Bytes32,
  /** True when the sibling is the left child, i.e. `bottom` is the right one. */
  isLeft: Bool,
}) {}

/** Byte by byte: `Bytes` has no equality helper, and comparing structs compares witnesses. */
function assertSameBytes(a: Bytes32, b: Bytes32, message: string): void {
  for (let i = 0; i < 32; i++) {
    a.bytes[i]!.value.assertEquals(b.bytes[i]!.value, message);
  }
}

export const MerkleInclusion = ZkProgram({
  name: 'flare-merkle-inclusion',
  publicOutput: PathSegment,

  methods: {
    /** One level. Independent of every other, so a whole path proves at once. */
    level: {
      privateInputs: [Bytes32, Sibling],
      async method(node: Bytes32, sibling: Sibling) {
        // Order is part of the commitment: swapping children changes the root.
        const left = Provable.if(sibling.isLeft, Bytes32, sibling.value, node);
        const right = Provable.if(sibling.isLeft, Bytes32, node, sibling.value);
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
