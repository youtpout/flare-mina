import { Bytes, Field, Keccak, Provable, SelfProof, Struct, UInt32, ZkProgram } from 'o1js';
import { Bytes32, Bytes64, PathSegment, assertSameBytes } from './MerkleInclusion.js';

/**
 * {MerkleInclusion}, four levels per proof instead of one.
 *
 * Not deployed. A level is 14,733 rows in a circuit that holds 65,536, so one
 * per proof leaves 78% of it empty while paying a full Pickles proof for it: a
 * depth-8 path costs eight levels plus seven merges, fifteen proofs to climb
 * eight hashes. Four fills the circuit at 59,271 rows, still one chunk, and
 * turns that path into two proofs and one merge — measured at 15.1s against
 * 53.6s.
 *
 * It is a separate program because adding a method changes the verification key,
 * and `AssetPort` and `MinaPortBridge` are live against the one they were
 * deployed with. Switching to this means redeploying both, which is only worth
 * doing when FDC rounds are deep enough to pay for it — at depth 3, which is
 * what Coston2 has shown so far, it saves nothing at all, since a path shorter
 * than four levels falls back on single levels anyway.
 *
 * Fixed at four rather than variable: a length flag would need a `Provable.if`
 * per level and would make a partial climb representable, which a fixed shape
 * rules out by construction.
 */

/**
 * True when `a` sorts before `b`, comparing as 256-bit big-endian numbers.
 *
 * Duplicated from {MerkleInclusion} rather than exported from it: that file is
 * what the deployed circuits compile against, and widening its exports invites
 * an edit there that quietly changes a verification key. The two must agree,
 * and the cross-check is that both climb to the same root.
 */
function sortsBefore(a: Bytes32, b: Bytes32) {
  const half = (bytes: { value: Field }[]) =>
    bytes.reduce((acc, byte) => acc.mul(256).add(byte.value), Field(0));

  const aHi = half(a.bytes.slice(0, 16));
  const bHi = half(b.bytes.slice(0, 16));
  const aLo = half(a.bytes.slice(16, 32));
  const bLo = half(b.bytes.slice(16, 32));

  return aHi.lessThan(bHi).or(aHi.equals(bHi).and(aLo.lessThan(bLo)));
}

/** One level up: sort the pair, hash it. */
function climb(node: Bytes32, sibling: Bytes32): Bytes32 {
  // Sorted, so the path carries no side information — which is also why a
  // sibling cannot be replayed on the wrong side to reach another root.
  const nodeFirst = sortsBefore(node, sibling);
  const left = Provable.if(nodeFirst, Bytes32, node, sibling);
  const right = Provable.if(nodeFirst, Bytes32, sibling, node);

  return Bytes32.from(Keccak.ethereum(Bytes64.from([...left.bytes, ...right.bytes])).bytes);
}

export const MerkleInclusionBatched = ZkProgram({
  name: 'flare-merkle-inclusion-batched',
  publicOutput: PathSegment,

  methods: {
    /** One level, for a path whose depth is not a multiple of four. */
    level: {
      privateInputs: [Bytes32, Bytes32],
      async method(node: Bytes32, sibling: Bytes32) {
        return {
          publicOutput: new PathSegment({
            bottom: node,
            top: climb(node, sibling),
            height: UInt32.one,
          }),
        };
      },
    },

    /** Four levels at once, which is what a proof should carry. */
    levels4: {
      privateInputs: [Bytes32, Bytes32, Bytes32, Bytes32, Bytes32],
      async method(
        node: Bytes32,
        first: Bytes32,
        second: Bytes32,
        third: Bytes32,
        fourth: Bytes32,
      ) {
        let top = climb(node, first);
        top = climb(top, second);
        top = climb(top, third);
        top = climb(top, fourth);

        return { publicOutput: new PathSegment({ bottom: node, top, height: UInt32.from(4) }) };
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

export class MerkleInclusionBatchedProof extends ZkProgram.Proof(MerkleInclusionBatched) {}
