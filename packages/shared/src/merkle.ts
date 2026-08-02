import { concatHex, keccak256, toHex, type Hex } from 'viem';
import { MAX_DEPOSIT_TREE_DEPTH } from './constants.js';

/**
 * Deposit Merkle tree.
 *
 * Design choices, all made to keep TS / Rust / Solidity byte-identical:
 *
 *  - Leaves are keccak256 over a 192-byte domain-separated ABI preimage
 *    (see `encoding.ts`). Internal nodes are keccak256 over 64 bytes, so leaf
 *    and node digests live in disjoint preimage spaces.
 *  - Node hashing sorts the pair (OpenZeppelin `MerkleProof` compatible), which
 *    keeps the on-chain verifier to a plain loop with no index bookkeeping.
 *    Consequence: the root commits to the SET of leaves, not to their order.
 *    That is sufficient here — a deposit leaf carries every field a claim needs
 *    and `claimedDeposits` is keyed by the leaf digest, so leaf position is
 *    never security-relevant. Do not reuse this tree where position matters.
 *  - The leaf set is padded to the next power of two with a fixed sentinel so
 *    the tree shape is a pure function of the leaf count. The sentinel is not a
 *    valid deposit preimage, so a padded slot can never be claimed.
 */

/** Padding leaf: keccak256("MinaPort.EmptyLeaf.v1"). */
export const EMPTY_LEAF: Hex = keccak256(toHex('MinaPort.EmptyLeaf.v1'));

/** Hash an ordered pair of nodes with sorted-pair (commutative) semantics. */
export function hashNodePair(a: Hex, b: Hex): Hex {
  return BigInt(a) <= BigInt(b) ? keccak256(concatHex([a, b])) : keccak256(concatHex([b, a]));
}

function nextPowerOfTwo(n: number): number {
  let size = 1;
  while (size < n) size <<= 1;
  return size;
}

export type MerkleTree = {
  /** Padded leaves, in insertion order. */
  leaves: Hex[];
  /** `layers[0]` is the padded leaf layer; the last layer is `[root]`. */
  layers: Hex[][];
  root: Hex;
};

/** Build the tree over `leaves` (already hashed). */
export function buildMerkleTree(leaves: Hex[]): MerkleTree {
  if (leaves.length === 0) throw new Error('cannot build a Merkle tree with no leaves');

  const size = nextPowerOfTwo(leaves.length);
  if (size > 1 << MAX_DEPOSIT_TREE_DEPTH) {
    throw new Error(`too many leaves: ${leaves.length} exceeds depth ${MAX_DEPOSIT_TREE_DEPTH}`);
  }

  const padded: Hex[] = [...leaves];
  while (padded.length < size) padded.push(EMPTY_LEAF);

  const layers: Hex[][] = [padded];
  while (layers[layers.length - 1]!.length > 1) {
    const current = layers[layers.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(hashNodePair(current[i]!, current[i + 1]!));
    }
    layers.push(next);
  }

  return { leaves: padded, layers, root: layers[layers.length - 1]![0]! };
}

/** Sibling path for the leaf at `index`, bottom-up. */
export function getMerkleProof(tree: MerkleTree, index: number): Hex[] {
  if (index < 0 || index >= tree.leaves.length) throw new Error(`leaf index out of range: ${index}`);

  const proof: Hex[] = [];
  let position = index;
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level]!;
    const siblingIndex = position % 2 === 0 ? position + 1 : position - 1;
    proof.push(layer[siblingIndex]!);
    position = Math.floor(position / 2);
  }
  return proof;
}

/** Verify a sibling path — mirror of `MerkleProof.verify` in Solidity. */
export function verifyMerkleProof(root: Hex, leaf: Hex, proof: Hex[]): boolean {
  let computed = leaf;
  for (const sibling of proof) computed = hashNodePair(computed, sibling);
  return computed.toLowerCase() === root.toLowerCase();
}
