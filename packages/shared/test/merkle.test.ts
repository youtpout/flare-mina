import { describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import {
  DuplicateDepositError,
  allClaimBundles,
  buildDepositBatch,
  buildMerkleTree,
  getMerkleProof,
  verifyMerkleProof,
  type DepositLeaf,
} from '../src/index.js';

function leaf(n: number): Hex {
  return keccak256(toHex(`leaf-${n}`));
}

describe('merkle tree', () => {
  it('pads to a power of two', () => {
    expect(buildMerkleTree([leaf(0), leaf(1), leaf(2)]).leaves).toHaveLength(4);
    expect(buildMerkleTree([leaf(0)]).leaves).toHaveLength(1);
    expect(buildMerkleTree(Array.from({ length: 5 }, (_, i) => leaf(i))).leaves).toHaveLength(8);
  });

  it('verifies every proof it produces', () => {
    for (const count of [1, 2, 3, 7, 8, 16]) {
      const leaves = Array.from({ length: count }, (_, i) => leaf(i));
      const tree = buildMerkleTree(leaves);
      leaves.forEach((l, i) => {
        expect(verifyMerkleProof(tree.root, l, getMerkleProof(tree, i))).toBe(true);
      });
    }
  });

  it('rejects a proof for a leaf that is not in the tree', () => {
    const tree = buildMerkleTree([leaf(0), leaf(1), leaf(2), leaf(3)]);
    expect(verifyMerkleProof(tree.root, leaf(99), getMerkleProof(tree, 0))).toBe(false);
  });

  it('rejects a tampered sibling path', () => {
    const tree = buildMerkleTree([leaf(0), leaf(1), leaf(2), leaf(3)]);
    const proof = getMerkleProof(tree, 1);
    proof[0] = leaf(42);
    expect(verifyMerkleProof(tree.root, leaf(1), proof)).toBe(false);
  });

  it('commits to the SET of leaves, not to their order', () => {
    // Sorted-pair node hashing is commutative, so sibling swaps at any level
    // leave the root unchanged. This is intentional and safe: a deposit leaf
    // carries every field a claim needs (nonce, sender, recipient, amount) and
    // `claimedDeposits` is keyed by the leaf digest, so leaf POSITION is never
    // security-relevant. The property asserted here is the one the bridge
    // actually relies on: changing the leaf set changes the root.
    expect(buildMerkleTree([leaf(0), leaf(1)]).root).toBe(buildMerkleTree([leaf(1), leaf(0)]).root);
    expect(buildMerkleTree([leaf(0), leaf(1), leaf(2), leaf(3)]).root).toBe(
      buildMerkleTree([leaf(2), leaf(3), leaf(0), leaf(1)]).root,
    );

    expect(buildMerkleTree([leaf(0), leaf(1)]).root).not.toBe(
      buildMerkleTree([leaf(0), leaf(2)]).root,
    );
    expect(buildMerkleTree([leaf(0), leaf(1)]).root).not.toBe(
      buildMerkleTree([leaf(0), leaf(1), leaf(2)]).root,
    );
  });

  it('rejects an empty leaf set', () => {
    expect(() => buildMerkleTree([])).toThrow(/no leaves/);
  });
});

describe('deposit batch', () => {
  const deposits: DepositLeaf[] = [
    {
      nonce: 0n,
      sender: { x: `0x${'0'.repeat(63)}1`, isOdd: false },
      recipientFlare: '0x1111111111111111111111111111111111111111',
      amountNanomina: 1_000_000_000n,
    },
    {
      nonce: 1n,
      sender: { x: `0x${'0'.repeat(63)}2`, isOdd: true },
      recipientFlare: '0x2222222222222222222222222222222222222222',
      amountNanomina: 5n,
    },
  ];

  const params = {
    bridgeId: `0x${'11'.repeat(32)}` as Hex,
    previousActionState: `0x${'00'.repeat(32)}` as Hex,
    newActionState: `0x${'aa'.repeat(32)}` as Hex,
    batchNonce: 1n,
  };

  it('produces claimable bundles for every deposit', () => {
    const batch = buildDepositBatch({ ...params, deposits });
    for (const bundle of allClaimBundles(batch)) {
      expect(verifyMerkleProof(bundle.depositsRoot, bundle.leafHash, bundle.merkleProof)).toBe(true);
    }
  });

  it('rejects duplicate deposits in the same batch', () => {
    expect(() => buildDepositBatch({ ...params, deposits: [deposits[0]!, deposits[0]!] })).toThrow(
      DuplicateDepositError,
    );
  });

  it('rejects an empty batch', () => {
    expect(() => buildDepositBatch({ ...params, deposits: [] })).toThrow(/empty/);
  });
});
