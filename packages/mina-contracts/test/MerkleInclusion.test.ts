import { beforeAll, describe, expect, it } from 'vitest';
import { Bool } from 'o1js';
import { concatHex, keccak256, type Hex } from 'viem';
import { Bytes32, MerkleInclusion, Sibling } from '../src/MerkleInclusion.js';

/**
 * Inclusion in a Flare voting-round tree.
 *
 * These run with `proofsEnabled: false`, so they exercise the constraints rather
 * than produce proofs — timings belong in the benchmark. What they pin is the
 * part a wrong implementation gets quietly wrong: that the hash matches what
 * Flare's Solidity actually computes, and that two segments cannot be joined
 * unless they meet.
 */

/**
 * Flare hashes a pair as `keccak256(abi.encode(sort([a, b])))`. Two `bytes32`
 * values abi-encode to their plain concatenation, so this is the whole rule.
 */
function shash(a: Hex, b: Hex): Hex {
  return a.toLowerCase() <= b.toLowerCase()
    ? keccak256(concatHex([a, b]))
    : keccak256(concatHex([b, a]));
}

const toBytes32 = (h: Hex) => Bytes32.fromHex(h.slice(2));
const toHex = (b: Bytes32): Hex =>
  `0x${b.bytes.map((x) => x.toNumber().toString(16).padStart(2, '0')).join('')}`;

/** Four leaves, so the path from leaf 0 to the root is two levels. */
const leaves: Hex[] = [0, 1, 2, 3].map(
  (i) => keccak256(`0x${i.toString(16).padStart(64, '0')}` as Hex) as Hex,
);
const nodeA = shash(leaves[0]!, leaves[1]!);
const nodeB = shash(leaves[2]!, leaves[3]!);
const root = shash(nodeA, nodeB);

/** A sibling, with the side bit Flare's ordering implies. */
function siblingOf(node: Hex, other: Hex): Sibling {
  return new Sibling({
    value: toBytes32(other),
    isLeft: Bool(other.toLowerCase() < node.toLowerCase()),
  });
}

beforeAll(async () => {
  await MerkleInclusion.compile({ proofsEnabled: false });
}, 600_000);

describe('climbing a Flare round tree', () => {
  it('reproduces the hash Flare computes', async () => {
    const { proof } = await MerkleInclusion.level(
      toBytes32(leaves[0]!),
      siblingOf(leaves[0]!, leaves[1]!),
    );

    expect(toHex(proof.publicOutput.top)).toBe(nodeA);
    expect(toHex(proof.publicOutput.bottom)).toBe(leaves[0]);
    expect(proof.publicOutput.height.toString()).toBe('1');
  }, 600_000);

  it('merges two levels into a path from leaf to root', async () => {
    const { proof: lower } = await MerkleInclusion.level(
      toBytes32(leaves[0]!),
      siblingOf(leaves[0]!, leaves[1]!),
    );
    const { proof: upper } = await MerkleInclusion.level(toBytes32(nodeA), siblingOf(nodeA, nodeB));
    const { proof: path } = await MerkleInclusion.merge(lower, upper);

    expect(toHex(path.publicOutput.bottom)).toBe(leaves[0]);
    expect(toHex(path.publicOutput.top)).toBe(root);
    // Height is what stops a short climb that happens to land on a known value
    // from passing as a full path.
    expect(path.publicOutput.height.toString()).toBe('2');
  }, 600_000);

  /**
   * The property the merge exists to enforce. Without it a prover could staple
   * together segments from unrelated parts of the tree and call it a path.
   */
  it('refuses segments that do not meet', async () => {
    const { proof: lower } = await MerkleInclusion.level(
      toBytes32(leaves[0]!),
      siblingOf(leaves[0]!, leaves[1]!),
    );
    // Starts at nodeB, not at nodeA where the lower segment ended.
    const { proof: elsewhere } = await MerkleInclusion.level(
      toBytes32(nodeB),
      siblingOf(nodeB, nodeA),
    );

    await expect(MerkleInclusion.merge(lower, elsewhere)).rejects.toThrow(/do not meet/);
  }, 600_000);

  /** Order is part of the commitment: the wrong side bit reaches a different node. */
  it('reaches a different node when the sibling side is flipped', async () => {
    const flipped = siblingOf(leaves[0]!, leaves[1]!);
    const { proof } = await MerkleInclusion.level(
      toBytes32(leaves[0]!),
      new Sibling({ value: flipped.value, isLeft: flipped.isLeft.not() }),
    );

    expect(toHex(proof.publicOutput.top)).not.toBe(nodeA);
  }, 600_000);
});
