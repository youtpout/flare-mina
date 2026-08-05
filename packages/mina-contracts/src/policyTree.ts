import { Field, MerkleTree, UInt32 } from 'o1js';
import type { PolicyKey } from '@minaport/shared';
import { POLICY_TREE_HEIGHT, PolicyWitness, Secp256k1, policyLeaf } from './SigningPolicyFold.js';

/**
 * Turns Flare's validator set into the Poseidon root the bridge stores. A leaf
 * commits to (index, publicKey, weight) together. An unknown key means no leaf,
 * which is fail-safe: it lowers the weight a fold can reach, never raises it.
 */

/** From viem's uncompressed form: `0x04 || x || y`. */
export function toSecp256k1(publicKey: string): Secp256k1 {
  const hex = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey;
  if (hex.length !== 130 || !hex.startsWith('04')) {
    throw new Error(`expected an uncompressed secp256k1 key, got ${hex.length / 2} bytes`);
  }
  return Secp256k1.from({
    x: BigInt(`0x${hex.slice(2, 66)}`),
    y: BigInt(`0x${hex.slice(66)}`),
  });
}

export type PolicyTree = {
  root: Field;
  /** Total weight the tree can actually prove, which is what a threshold sees. */
  provableWeight: number;
  witnessFor(index: number): PolicyWitness;
  tree: MerkleTree;
};

/**
 * Leaves sit at their policy index, not packed: the index is part of both the
 * commitment and the ordering the fold relies on.
 */
export function buildPolicyTree(keys: PolicyKey[]): PolicyTree {
  const tree = new MerkleTree(POLICY_TREE_HEIGHT);
  const capacity = 2 ** (POLICY_TREE_HEIGHT - 1);

  for (const voter of keys) {
    if (voter.index >= capacity) {
      throw new Error(`policy index ${voter.index} exceeds the tree's ${capacity} leaves`);
    }
    tree.setLeaf(
      BigInt(voter.index),
      policyLeaf(
        toSecp256k1(voter.publicKey),
        UInt32.from(voter.index),
        UInt32.from(voter.weight),
      ),
    );
  }

  return {
    root: tree.getRoot(),
    provableWeight: keys.reduce((sum, v) => sum + v.weight, 0),
    witnessFor: (index) => new PolicyWitness(tree.getWitness(BigInt(index))),
    tree,
  };
}
