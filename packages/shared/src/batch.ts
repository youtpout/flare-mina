import type { Hex } from 'viem';
import { hashDepositLeaf } from './encoding.js';
import { buildMerkleTree, getMerkleProof, type MerkleTree } from './merkle.js';
import type { DepositLeaf, FlareSettlementPublicValues } from './types.js';

/**
 * Deposit batch assembly.
 *
 * A batch is the unit the prover commits to and the Flare bridge accepts. It
 * carries the Mina action-state transition it corresponds to, plus a Merkle
 * root over the deposits it authorises.
 *
 * The action states themselves are produced by the Mina zkApp (Poseidon hash
 * chain) and are opaque 32-byte values here — this module owns only the
 * Flare-facing keccak commitment.
 */

export type DepositBatch = {
  bridgeId: Hex;
  previousActionState: Hex;
  newActionState: Hex;
  batchNonce: bigint;
  deposits: DepositLeaf[];
  leafHashes: Hex[];
  tree: MerkleTree;
  depositsRoot: Hex;
};

export class DuplicateDepositError extends Error {
  constructor(public readonly leafHash: Hex) {
    super(`duplicate deposit leaf in batch: ${leafHash}`);
    this.name = 'DuplicateDepositError';
  }
}

/**
 * Build a batch from an ordered list of deposits.
 *
 * Rejects duplicates: two identical leaves in one batch would produce two
 * identical claim ids, and the second claim would silently fail on-chain after
 * the first one succeeded. Catching it here keeps the relayer honest and makes
 * the "no deposit appears twice" guarantee checkable outside the circuit too.
 */
export function buildDepositBatch(params: {
  bridgeId: Hex;
  previousActionState: Hex;
  newActionState: Hex;
  batchNonce: bigint;
  deposits: DepositLeaf[];
}): DepositBatch {
  if (params.deposits.length === 0) throw new Error('cannot build an empty deposit batch');

  const seen = new Set<string>();
  const leafHashes = params.deposits.map((deposit) => {
    const hash = hashDepositLeaf(deposit);
    const key = hash.toLowerCase();
    if (seen.has(key)) throw new DuplicateDepositError(hash);
    seen.add(key);
    return hash;
  });

  const tree = buildMerkleTree(leafHashes);

  return {
    bridgeId: params.bridgeId,
    previousActionState: params.previousActionState,
    newActionState: params.newActionState,
    batchNonce: params.batchNonce,
    deposits: params.deposits,
    leafHashes,
    tree,
    depositsRoot: tree.root,
  };
}

/** Public values the SP1 guest is expected to commit for this batch. */
export function batchPublicValues(batch: DepositBatch): FlareSettlementPublicValues {
  return {
    proofValid: true,
    bridgeId: batch.bridgeId,
    previousActionState: batch.previousActionState,
    newActionState: batch.newActionState,
    depositsRoot: batch.depositsRoot,
    batchNonce: batch.batchNonce,
  };
}

/** Everything a recipient needs to call `claimDeposit`. */
export type ClaimBundle = {
  deposit: DepositLeaf;
  leafHash: Hex;
  depositsRoot: Hex;
  merkleProof: Hex[];
};

export function claimBundleFor(batch: DepositBatch, index: number): ClaimBundle {
  const deposit = batch.deposits[index];
  const leafHash = batch.leafHashes[index];
  if (!deposit || !leafHash) throw new Error(`no deposit at index ${index}`);

  return {
    deposit,
    leafHash,
    depositsRoot: batch.depositsRoot,
    merkleProof: getMerkleProof(batch.tree, index),
  };
}

/** All claim bundles, in batch order. */
export function allClaimBundles(batch: DepositBatch): ClaimBundle[] {
  return batch.deposits.map((_, index) => claimBundleFor(batch, index));
}
