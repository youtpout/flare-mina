import { Field, MerkleTree, UInt32 } from 'o1js';
import type { PolicyKey } from '@minaport/shared';
import { POLICY_TREE_HEIGHT, PolicyWitness, Secp256k1, policyLeaf } from './SigningPolicyFold.js';

/**
 * Turns Flare's validator set into the Merkle root the bridge stores.
 *
 * This is the join between the two halves of the return path. `@minaport/shared`
 * reads the authorised signers out of `Relay` — addresses, weights, and public
 * keys recovered from their signatures — and `SigningPolicyFold` proves a signer
 * belongs to a Poseidon tree. This builds that tree.
 *
 * # What a leaf commits to
 *
 * `(index, publicKey.x, publicKey.y, weight)`, all four together. A signer
 * cannot be invented and a real one's weight cannot be inflated, because both
 * live under the same hash — and the index is checked against the witness so a
 * signer cannot be presented at a position it does not hold.
 *
 * # What an empty leaf means
 *
 * Nothing can be proven at that index. Voters whose public key has never been
 * observed simply have no leaf, which is fail-safe: an incomplete tree lowers
 * the weight a fold can reach and can never raise it. On Coston2 two rounds of
 * history already cover enough weight to clear the threshold.
 */

/**
 * Convert a recovered secp256k1 key into the circuit's representation.
 *
 * Input is the uncompressed form viem returns: `0x04 || x(32) || y(32)`.
 */
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
 * Build the tree from voters whose keys are known.
 *
 * Leaves are placed at their policy index, not packed — the index is part of
 * the commitment and of the ordering the fold relies on, so shifting a voter
 * into a free slot would silently break both.
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
