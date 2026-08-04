import { Bool, Bytes, Keccak, Provable, SelfProof, Struct, UInt32, ZkProgram } from 'o1js';

/**
 * Proves a leaf is in a keccak Merkle tree, one level at a time.
 *
 * # Why this is its own program
 *
 * The other half of a verified withdrawal — `SigningPolicyFold` — proves that
 * Flare's validators signed a root. It does not prove what is *in* that root.
 * This does, and keeping them apart matters for three reasons:
 *
 *   - they have unrelated depths, so folding them together would force the
 *     shallower one to carry the deeper one's recursion;
 *   - they are independent, so they can be proven in parallel;
 *   - the consumer binds them by the root, which is the public output of both,
 *     and that binding is a single equality rather than a shared circuit.
 *
 * # Why it recurses over so few levels
 *
 * Keccak is not free on Mina the way Poseidon is. Measured:
 *
 *   one Poseidon over two fields        13 rows
 *   one keccak256 over 64 bytes     14,636 rows      ×1126
 *
 * Against a 65,536-row domain that is **four levels per proof**, and eight
 * levels (115,881 rows) already do not fit. So the path is walked in short
 * recursive hops rather than in one shot.
 *
 * That ratio is also the reason this bridge verifies Mina signatures directly
 * in Solidity rather than wrapping them in a proof: the asymmetry runs the
 * other way. Ethereum-flavoured hashing is cheap on an EVM and expensive on
 * Mina; Pallas arithmetic is the reverse.
 *
 * # STATUS: does not compile yet
 *
 * The constraint system builds and measures — `base` 58,859 rows, `step`
 * 58,943, both inside the 65,536 domain, which is what confirmed four levels
 * per proof is the right split. `compile()` then fails inside Pickles with:
 *
 *   length mismatch in Array.map2_exn: 1 <> 2
 *
 * It is not the row count and not the per-byte conditionals — selecting whole
 * `Bytes32` values instead of mapping over bytes changed nothing. The sibling
 * program `SigningPolicyFold` has the same base/step shape and compiles, so
 * the difference is somewhere in this program's `Bytes32`-heavy public output.
 * Committed unfinished because the measurements it produced are the useful
 * part and they are real; the compile is the next thing to chase.
 */

export class Bytes32 extends Bytes(32) {}
export class Bytes64 extends Bytes(64) {}

/** How many levels one proof walks. Four is what the domain allows. */
export const LEVELS_PER_STEP = 4;

export class InclusionState extends Struct({
  /** The leaf this path started from. Carried so a consumer can bind it. */
  leaf: Bytes32,
  /** The node reached so far. At the end of the walk, the tree's root. */
  node: Bytes32,
  /** Levels climbed. The consumer checks this against the expected depth. */
  depth: UInt32,
}) {}

/** One level: a sibling, and which side it sits on. */
export class Step extends Struct({
  sibling: Bytes32,
  /** True when the sibling is on the left, i.e. the current node is the right child. */
  siblingIsLeft: Bool,
}) {}

/**
 * Hash a pair in the order the tree does.
 *
 * Order is part of the commitment, not a detail: swapping the children of one
 * node yields a different root, and an implementation that sorted them would
 * accept paths the tree never contained.
 */
function hashPair(node: Bytes32, step: Step): Bytes32 {
  // Selected as whole 32-byte values rather than byte by byte: mapping
  // `Provable.if` over the bytes builds an array o1js cannot reconcile between
  // the two methods, and fails at compile with a shape mismatch rather than
  // anywhere useful.
  const left = Provable.if(step.siblingIsLeft, Bytes32, step.sibling, node);
  const right = Provable.if(step.siblingIsLeft, Bytes32, node, step.sibling);
  return Bytes32.from(Keccak.ethereum(Bytes64.from([...left.bytes, ...right.bytes])).bytes);
}

export const MerkleInclusion = ZkProgram({
  name: 'flare-merkle-inclusion',
  publicOutput: InclusionState,

  methods: {
    /** Start from the leaf and climb up to `LEVELS_PER_STEP` levels. */
    base: {
      privateInputs: [Bytes32, Step, Step, Step, Step, UInt32],
      async method(leaf: Bytes32, s0: Step, s1: Step, s2: Step, s3: Step, levels: UInt32) {
        let node = leaf;
        // `levels` says how many of the four are real. Padding a short path
        // with repeated siblings would change the root, so unused levels are
        // skipped rather than hashed.
        const steps = [s0, s1, s2, s3];
        for (let i = 0; i < LEVELS_PER_STEP; i++) {
          const used = levels.greaterThan(UInt32.from(i));
          const climbed = hashPair(node, steps[i]!);
          node = Provable.if(used, Bytes32, climbed, node);
        }

        return { publicOutput: new InclusionState({ leaf, node, depth: levels }) };
      },
    },

    /** Continue an existing walk. Same shape, so depth is unbounded. */
    step: {
      privateInputs: [SelfProof, Step, Step, Step, Step, UInt32],
      async method(
        previous: SelfProof<undefined, InclusionState>,
        s0: Step,
        s1: Step,
        s2: Step,
        s3: Step,
        levels: UInt32,
      ) {
        previous.verify();
        const state = previous.publicOutput;

        let node = state.node;
        const steps = [s0, s1, s2, s3];
        for (let i = 0; i < LEVELS_PER_STEP; i++) {
          const used = levels.greaterThan(UInt32.from(i));
          const climbed = hashPair(node, steps[i]!);
          node = Provable.if(used, Bytes32, climbed, node);
        }

        return {
          publicOutput: new InclusionState({
            leaf: state.leaf,
            node,
            depth: state.depth.add(levels),
          }),
        };
      },
    },
  },
});

export class MerkleInclusionProof extends ZkProgram.Proof(MerkleInclusion) {}
