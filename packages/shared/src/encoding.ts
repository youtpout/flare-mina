import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { DEPOSIT_LEAF_DOMAIN, WITHDRAWAL_LEAF_DOMAIN } from './constants.js';
import type { DepositLeaf, FlareSettlementPublicValues, WithdrawalRecord } from './types.js';

/**
 * Canonical ABI layout of a deposit leaf preimage.
 *
 * Solidity mirror: `MinaPortEncoding.hashDepositLeaf`
 * Rust mirror:     `minaport_core::leaf::DepositLeaf::hash`
 *
 * The preimage is 6 ABI words (192 bytes). Internal Merkle nodes are hashed
 * over exactly 64 bytes, so a leaf digest can never be confused with a node
 * digest — this is what makes the tree second-preimage resistant despite the
 * sorted-pair node hashing.
 */
export const DEPOSIT_LEAF_ABI = [
  { name: 'domain', type: 'bytes32' },
  { name: 'nonce', type: 'uint64' },
  { name: 'senderMinaX', type: 'bytes32' },
  { name: 'senderMinaIsOdd', type: 'bool' },
  { name: 'recipientFlare', type: 'address' },
  { name: 'amountNanomina', type: 'uint64' },
] as const;

const UINT64_MAX = (1n << 64n) - 1n;

function assertUint64(value: bigint, label: string): void {
  if (value < 0n || value > UINT64_MAX) throw new Error(`${label} out of uint64 range: ${value}`);
}

/** ABI-encoded preimage of a deposit leaf. Exposed for fixture/debug tooling. */
export function encodeDepositLeaf(leaf: DepositLeaf): Hex {
  assertUint64(leaf.nonce, 'nonce');
  assertUint64(leaf.amountNanomina, 'amountNanomina');
  if (leaf.amountNanomina === 0n) throw new Error('deposit amount must be non-zero');

  return encodeAbiParameters(DEPOSIT_LEAF_ABI, [
    DEPOSIT_LEAF_DOMAIN,
    leaf.nonce,
    leaf.sender.x,
    leaf.sender.isOdd,
    leaf.recipientFlare,
    leaf.amountNanomina,
  ]);
}

/** keccak256 digest of a deposit leaf — this is what lands in the Merkle tree. */
export function hashDepositLeaf(leaf: DepositLeaf): Hex {
  return keccak256(encodeDepositLeaf(leaf));
}

/**
 * Deterministic claim id, used by MinaPortBridge to mark a deposit as spent.
 * Distinct from the leaf digest only for clarity of intent; both are unique per
 * (nonce, sender, recipient, amount) tuple.
 */
export function depositClaimId(leaf: DepositLeaf): Hex {
  return hashDepositLeaf(leaf);
}

export const WITHDRAWAL_LEAF_ABI = [
  { name: 'domain', type: 'bytes32' },
  { name: 'nonce', type: 'uint64' },
  { name: 'sender', type: 'address' },
  { name: 'minaRecipient', type: 'bytes32' },
  { name: 'amountNanomina', type: 'uint64' },
] as const;

/** keccak256 digest of a withdrawal record (Flare -> Mina direction). */
export function hashWithdrawal(record: WithdrawalRecord): Hex {
  assertUint64(record.nonce, 'nonce');
  assertUint64(record.amountNanomina, 'amountNanomina');
  return keccak256(
    encodeAbiParameters(WITHDRAWAL_LEAF_ABI, [
      WITHDRAWAL_LEAF_DOMAIN,
      record.nonce,
      record.sender,
      record.minaRecipient,
      record.amountNanomina,
    ]),
  );
}

/**
 * ABI layout of the SP1 public values.
 *
 * The SP1 guest commits exactly these bytes; `MinaPortBridge.submitDepositBatch`
 * abi-decodes them after the verifier has bound them to the proof. The Rust
 * mirror uses `alloy_sol_types::sol!` over the same struct so both sides are
 * generated from the same ABI definition.
 */
export const SETTLEMENT_PUBLIC_VALUES_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'proofValid', type: 'bool' },
      { name: 'bridgeId', type: 'bytes32' },
      { name: 'previousActionState', type: 'bytes32' },
      { name: 'newActionState', type: 'bytes32' },
      { name: 'depositsRoot', type: 'bytes32' },
      { name: 'batchNonce', type: 'uint64' },
    ],
  },
] as const;

export function encodeSettlementPublicValues(values: FlareSettlementPublicValues): Hex {
  assertUint64(values.batchNonce, 'batchNonce');
  return encodeAbiParameters(SETTLEMENT_PUBLIC_VALUES_ABI, [
    {
      proofValid: values.proofValid,
      bridgeId: values.bridgeId,
      previousActionState: values.previousActionState,
      newActionState: values.newActionState,
      depositsRoot: values.depositsRoot,
      batchNonce: values.batchNonce,
    },
  ]);
}
