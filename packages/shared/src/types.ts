import type { Address, Hex } from 'viem';

/**
 * Canonical Mina public key in its decomposed (curve point) form.
 *
 * A Mina public key is a Pallas curve point compressed to (x, isOdd). This is
 * the only form that can be hashed inside a zkApp, so it is the form used in
 * every cross-chain leaf. `x` is the big-endian 32-byte encoding of the field
 * element (note: the base58 representation stores it little-endian).
 */
export type MinaPublicKeyParts = {
  x: Hex; // bytes32, big-endian
  isOdd: boolean;
};

/** A Mina -> Flare deposit, in its canonical cross-chain form. */
export type DepositLeaf = {
  /** Per-sender monotonic nonce assigned by the Mina bridge zkApp. */
  nonce: bigint;
  /** Depositor's Mina account. */
  sender: MinaPublicKeyParts;
  /** Flare address entitled to claim the minted wMINA. */
  recipientFlare: Address;
  /** Amount in nanomina (1 MINA = 1e9). Must be non-zero. */
  amountNanomina: bigint;
};

/** Public values committed by the SP1 guest and consumed by MinaPortBridge. */
export type FlareSettlementPublicValues = {
  proofValid: boolean;
  bridgeId: Hex;
  previousActionState: Hex;
  newActionState: Hex;
  depositsRoot: Hex;
  batchNonce: bigint;
};

/** A Flare -> Mina withdrawal, as emitted by MinaPortBridge.WithdrawToMina. */
export type WithdrawalRecord = {
  nonce: bigint;
  sender: Address;
  /** Mina recipient, encoded as bytes32 (see `encodeMinaRecipient`). */
  minaRecipient: Hex;
  amountNanomina: bigint;
};

/** Canonical payload signed by BOTH accounts to link them off-chain. */
export type LinkAccounts = {
  flareAddress: Address;
  minaPublicKey: string; // base58 "B62..."
  flareChainId: bigint;
  minaNetworkId: string; // e.g. "mina:devnet"
  nonce: bigint;
  expiry: bigint; // unix seconds
};

/** A link proven by one signature from each side. */
export type SignedAccountLink = {
  payload: LinkAccounts;
  /** EIP-712 signature produced by the Flare account. */
  flareSignature: Hex;
  /** Mina Schnorr signature (field/scalar pair) produced by the Snap. */
  minaSignature: { field: string; scalar: string };
};

export type BridgeStatus =
  | 'idle'
  | 'awaiting-wallet-signature'
  | 'mina-transaction-submitted'
  | 'mina-transaction-confirmed'
  | 'proof-generation'
  | 'flare-proof-submitted'
  | 'claim-available'
  | 'claim-submitted'
  | 'completed'
  | 'failed';

export type WithdrawalStatus =
  | 'idle'
  | 'burn-submitted'
  | 'burn-confirmed'
  | 'fdc-requested'
  | 'fdc-finalized'
  | 'mina-proof-generation'
  | 'mina-claim-submitted'
  | 'completed'
  | 'failed';
