/**
 * MinaPort protocol constants.
 *
 * Every constant here is part of the consensus-critical encoding shared by
 * TypeScript, Rust and Solidity. Changing any value here is a breaking protocol
 * change and MUST be mirrored in:
 *   - packages/prover/crates/minaport-core/src/constants.rs
 *   - packages/flare-contracts/src/libraries/MinaPortEncoding.sol
 *   - packages/mina-contracts/src/constants.ts
 *
 * The cross-language fixture tests fail loudly when the three drift apart.
 */

import { keccak256, toHex, type Hex } from 'viem';

/** MINA has 9 decimals: the base unit is 1 nanomina. */
export const MINA_DECIMALS = 9;

/**
 * FMINA uses the SAME number of decimals as MINA (9).
 *
 * This gives an exact 1:1 mapping between one nanomina locked on Mina and one
 * FMINA base unit minted on Flare. No conversion, no rounding, no dust — the
 * collateral invariant `totalSupply(FMINA) == escrow balance` is an integer
 * equality that holds at every point in time.
 */
export const FMINA_DECIMALS = 9;

/**
 * Domain separator strings. The 32-byte tags are derived as keccak256(string)
 * so that the value is verifiable by inspection in all three languages rather
 * than being a magic constant copied around.
 */
export const DEPOSIT_LEAF_DOMAIN_STRING = 'MinaPort.Deposit.v1';
export const WITHDRAWAL_LEAF_DOMAIN_STRING = 'MinaPort.Withdrawal.v1';
export const BATCH_DOMAIN_STRING = 'MinaPort.DepositBatch.v1';

/**
 * Domain separator for the Mina->Flare deposit leaf: a fixed 32-byte tag
 * included in every deposit leaf preimage so that a leaf can never be
 * reinterpreted as any other structure in the protocol (withdrawal leaf, batch
 * header, internal Merkle node).
 */
export const DEPOSIT_LEAF_DOMAIN: Hex = keccak256(toHex(DEPOSIT_LEAF_DOMAIN_STRING));

/** Domain separator for the Flare->Mina withdrawal leaf. */
export const WITHDRAWAL_LEAF_DOMAIN: Hex = keccak256(toHex(WITHDRAWAL_LEAF_DOMAIN_STRING));

/** Domain separator for the deposit batch commitment. */
export const BATCH_DOMAIN: Hex = keccak256(toHex(BATCH_DOMAIN_STRING));

/**
 * Domain separator used inside the Mina zkApp Poseidon hashes.
 * Poseidon operates on field elements, so this is a small field-safe tag
 * rather than a 32-byte keccak digest.
 */
export const MINA_BRIDGE_DOMAIN_POSEIDON = 0x4d494e41504f5254n; // ASCII "MINAPORT"

/** Supported networks for the hackathon MVP. */
export const FLARE_CHAINS = {
  coston2: 114,
  flare: 14,
} as const;

export const MINA_NETWORKS = {
  devnet: 'mina:devnet',
  mainnet: 'mina:mainnet',
} as const;

export type FlareChainName = keyof typeof FLARE_CHAINS;
export type MinaNetworkId = (typeof MINA_NETWORKS)[keyof typeof MINA_NETWORKS];

/**
 * Pallas base field order (Fp) — the field Mina public key `x` coordinates live in.
 *
 * Identical to the constant used by `ZekoAddress.sol` in the ethereum-settlement
 * repo; MinaPort reuses that packing scheme so both bridges agree on how a Mina
 * account is represented inside a 256-bit EVM word.
 */
export const PALLAS_FIELD_ORDER =
  28948022309329048855892746252171976963363056481941560715954676764349967630337n;

/** Maximum depth of the deposit Merkle tree (=> at most 1024 deposits/batch). */
export const MAX_DEPOSIT_TREE_DEPTH = 10;

