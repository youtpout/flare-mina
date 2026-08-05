import { Bool, Bytes, Keccak, Provable, SelfProof, Struct, UInt32, ZkProgram } from 'o1js';

/**
 * Proves a leaf is in a keccak Merkle tree, by merging path segments.
 *
 * # What it is for
 *
 * Flare's Data Connector publishes one Merkle root per voting round, over every
 * attestation confirmed in that round, and the signing policy signs that root.
 * `SigningPolicyFold` proves enough validator weight signed it; this proves what
 * is *inside* it. Together they replace `withdrawalAttestor` — a burn on Flare
 * becomes a release on Mina with nobody trusted to say it happened.
 *
 * The two are separate programs on purpose: they have unrelated depths, they can
 * be proven in parallel, and the consumer binds them by the root, which is a
 * public output of both. One equality, not one shared circuit.
 *
 * # Why one level per proof, and merges
 *
 * Keccak is not free on Mina the way Poseidon is. Measured, against a
 * 65,536-row domain:
 *
 *   Poseidon over two fields             13 rows
 *   keccak256 over 64 bytes          14,636 rows      x1126
 *
 * An earlier version walked four levels per proof inside a loop, each guarded by
 * a `Provable.if` on whether that level was used. It measured 58,859 rows and
 * never compiled.
 *
 * Merging removes both problems. Each proof does exactly one hash, so the
 * conditional disappears — a segment that is not needed is simply not proven.
 * Segments are independent, so a whole path can be proven at once rather than
 * bottom-up in sequence, and depth costs log(n) merges instead of n steps.
 *
 * # How segments chain
 *
 * A segment records where it started, where it reached, and how far it climbed.
 * A merge asserts the left segment's top *is* the right segment's bottom, which
 * is what makes the two describe one continuous path rather than two unrelated
 * fragments. Height sums, so the consumer can require the tree's exact depth and
 * reject a short path that happened to land on the right value.
 *
 * # On Flare's pair ordering
 *
 * Flare hashes pairs sorted: `keccak256(abi.encode(sort([a, b])))`. This carries
 * an explicit side bit instead of sorting in-circuit, which is sound for the same
 * reason it is cheap: the published root already fixes the ordering, so a prover
 * who flips a bit computes a different hash and simply fails to reach the root.
 * Sorting would cost a 32-byte comparison per level to constrain something the
 * root constrains for free.
 */

export class Bytes32 extends Bytes(32) {}
export class Bytes64 extends Bytes(64) {}

/**
 * A stretch of the path from a leaf towards the root.
 *
 * `bottom` and `top` are what merges chain on; `height` is what stops a prover
 * from presenting a partial climb as a complete one.
 */
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

/** Assert two 32-byte values are equal, byte by byte. */
function assertSameBytes(a: Bytes32, b: Bytes32, message: string): void {
  // `Bytes` has no equality helper, and comparing the structs wholesale would
  // compare witnesses rather than values.
  for (let i = 0; i < 32; i++) {
    a.bytes[i]!.value.assertEquals(b.bytes[i]!.value, message);
  }
}

export const MerkleInclusion = ZkProgram({
  name: 'flare-merkle-inclusion',
  publicOutput: PathSegment,

  methods: {
    /**
     * One level: hash a node with its sibling to get the parent.
     *
     * Independent of every other level, which is the point — a full path can be
     * proven all at once and merged afterwards.
     */
    level: {
      privateInputs: [Bytes32, Sibling],
      async method(node: Bytes32, sibling: Sibling) {
        // Order is part of the commitment, not a detail: swapping the children
        // of one node yields a different root.
        const left = Provable.if(sibling.isLeft, Bytes32, sibling.value, node);
        const right = Provable.if(sibling.isLeft, Bytes32, node, sibling.value);
        const parent = Bytes32.from(
          Keccak.ethereum(Bytes64.from([...left.bytes, ...right.bytes])).bytes,
        );

        return { publicOutput: new PathSegment({ bottom: node, top: parent, height: UInt32.one }) };
      },
    },

    /**
     * Join two segments into one.
     *
     * No hashing here — both sides already did theirs. This only checks they
     * meet, which is what turns two fragments into a path.
     */
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

        // Contiguity. Without it a prover could staple together two segments
        // from unrelated parts of the tree and call the result a path.
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
