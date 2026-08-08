import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { concatHex, keccak256, type Hex } from 'viem';
import { Bytes32, MerkleInclusion } from '../src/MerkleInclusion.js';

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

/** A real attested response, its path, and the round root the Relay stores. */
const fixture = JSON.parse(
  readFileSync(
    new URL('../../shared/test/fixtures/fdc-evm-transaction.json', import.meta.url),
    'utf8',
  ),
) as { response_hex: Hex; proof: Hex[]; relayRoot: Hex };

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

/**
 * A sixteen-leaf tree, so the path from leaf 0 to the root is four levels —
 * exactly what `levels4` climbs in one circuit.
 */
const wideLeaves: Hex[] = Array.from(
  { length: 16 },
  (_, i) => keccak256(`0x${(i + 100).toString(16).padStart(64, '0')}` as Hex) as Hex,
);

/**
 * The path and root, computed the way OpenZeppelin's `processProof` does.
 *
 * Written out here rather than taken from the circuit: a test that builds its
 * expectation with the code under test only ever confirms the code is
 * self-consistent, which is how the earlier left/right bug survived a green
 * suite.
 */
function widePathTo(index: number): { siblings: Hex[]; root: Hex } {
  const siblings: Hex[] = [];
  let level = wideLeaves;
  let i = index;

  while (level.length > 1) {
    siblings.push(level[i ^ 1]!);
    const next: Hex[] = [];
    for (let j = 0; j < level.length; j += 2) next.push(shash(level[j]!, level[j + 1]!));
    level = next;
    i >>= 1;
  }
  return { siblings, root: level[0]! };
}

/**
 * A sibling is now just a value.
 *
 * It used to carry a side bit that the caller computed. The circuit produced
 * the right root whenever that bit was right — and every test supplied it
 * right — so nothing ever failed. But soundness rested on an untrusted input:
 * a caller passing the wrong bit climbed to a different root. The circuit sorts
 * for itself now, so there is nothing left to get wrong.
 */
function siblingOf(_node: Hex, other: Hex): Bytes32 {
  return toBytes32(other);
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

  /**
   * Sorting is the circuit's job now, so the same pair climbs to the same
   * parent whichever way round it is handed in. That is what makes a path
   * carry no side information — and what makes it match Flare's trees.
   */
  it('reaches the same parent whichever side the sibling is given', async () => {
    const a = await MerkleInclusion.level(toBytes32(leaves[0]!), toBytes32(leaves[1]!));
    const b = await MerkleInclusion.level(toBytes32(leaves[1]!), toBytes32(leaves[0]!));

    expect(toHex(a.proof.publicOutput.top)).toBe(nodeA);
    expect(toHex(b.proof.publicOutput.top)).toBe(nodeA);
  }, 900_000);

  /**
   * The root here comes from a tree this file builds by the published rule,
   * not from asking the circuit what it thinks. A suite that builds its
   * expectation with the code under test only confirms self-consistency, which
   * is how the earlier left/right bug survived a green run.
   */
  it('reaches a root an independent implementation computes', async () => {
    const { siblings, root: expected } = widePathTo(0);

    let segment = (await MerkleInclusion.level(toBytes32(wideLeaves[0]!), toBytes32(siblings[0]!)))
      .proof;
    for (const sibling of siblings.slice(1)) {
      const next = (await MerkleInclusion.level(segment.publicOutput.top, toBytes32(sibling)))
        .proof;
      segment = (await MerkleInclusion.merge(segment, next)).proof;
    }

    expect(toHex(segment.publicOutput.top)).toBe(expected);
  }, 1_800_000);

  /**
   * The one that matters: a real FDC round.
   *
   * The leaf, the siblings and the root all come from Coston2 — the response
   * Flare's attestation providers agreed on for a real `AssetLocked`, and the
   * root the Relay contract stores for that round. So this checks the circuit
   * against a value the validator set signed, not against this file's own idea
   * of how a tree works.
   */
  it('climbs a real FDC round to the root the validators signed', async () => {
    const leaf = keccak256(fixture.response_hex);

    let segment = (await MerkleInclusion.level(toBytes32(leaf), toBytes32(fixture.proof[0]!)))
      .proof;
    for (const sibling of fixture.proof.slice(1)) {
      const next = (
        await MerkleInclusion.level(segment.publicOutput.top, toBytes32(sibling))
      ).proof;
      segment = (await MerkleInclusion.merge(segment, next)).proof;
    }

    expect(toHex(segment.publicOutput.top).toLowerCase()).toBe(fixture.relayRoot.toLowerCase());
    expect(Number(segment.publicOutput.height.toBigint())).toBe(fixture.proof.length);
  }, 1_800_000);
});
