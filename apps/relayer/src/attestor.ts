import { encodeAbiParameters, isAddress, keccak256, toHex, type Address, type Hex } from 'viem';

/**
 * The escrow attestor.
 *
 * A Mina deposit needs two independent authorisations before FMINA is minted.
 * The depositor's Schnorr signature binds the recipient and the amount, and is
 * verified on-chain against Pallas. This service supplies the other half: it
 * watches the Mina chain and signs that the escrow actually happened.
 *
 * # What it can and cannot do
 *
 * It cannot redirect a deposit, inflate one, or mint to itself — the
 * depositor's signature covers the recipient and amount, and the contract
 * checks it. A dishonest attestor can only refuse to sign, or sign for an
 * escrow that never happened.
 *
 * That last one is the real trust assumption and it is not hidden anywhere: a
 * signature proves intent, not custody, so somebody has to look at the Mina
 * chain. Until Mina state is proven on Flare, that somebody is this service.
 *
 * # Why the recipient travels in the memo
 *
 * Mina payments carry a 32-byte memo, and an EVM address is 20 bytes. Putting
 * the recipient there means the attestor reads the destination off the chain it
 * is already watching, instead of consulting a database that could disagree
 * with it. There is no pre-registration step and no state to keep in sync.
 */

/** Domain tag; must equal `MinaPortBridge.DEPOSIT_INTENT_DOMAIN`. */
export const DEPOSIT_INTENT_DOMAIN: Hex = keccak256(toHex('FlareXMina.DepositIntent.v1'));

/** A confirmed payment into the bridge account, as read from a Mina node. */
export type MinaPayment = {
  /** Transaction hash, for idempotency. */
  hash: string;
  /** Depositor's Mina address, base58. */
  from: string;
  /** Bridge account, base58. */
  to: string;
  /** Amount in nanomina. */
  amountNanomina: bigint;
  /** Raw memo bytes as written on-chain. */
  memo: string;
  /** Block height, used to apply a confirmation depth. */
  blockHeight: number;
};

export type AttestationTarget = {
  minaSender: Hex;
  recipient: Address;
  amountNanomina: bigint;
  nonce: bigint;
};

export type Rejected = { ok: false; reason: string };
export type Accepted = { ok: true; target: AttestationTarget };
export type Decision = Accepted | Rejected;

/**
 * Recover the Flare recipient a memo designates.
 *
 * Accepts a `0x`-prefixed address or the bare 40 hex characters — a wallet may
 * write either, and rejecting one of them would strand a deposit for a reason
 * the depositor could not have anticipated.
 *
 * Anything else is refused rather than guessed at. A memo is user input, and a
 * misparse here mints to the wrong account.
 */
export function recipientFromMemo(memo: string): Address | null {
  const trimmed = memo.trim();
  const candidate = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(candidate)) return null;
  return isAddress(candidate) ? (candidate as Address) : null;
}

export type AttestorPolicy = {
  /** Bridge account on Mina; payments elsewhere are none of our business. */
  bridgeAddress: string;
  /** Blocks a payment must be buried under before it is attested. */
  confirmations: number;
  /** Smallest deposit worth attesting, in nanomina. */
  minAmountNanomina: bigint;
  /** Largest single deposit this attestor will sign for. */
  maxAmountNanomina: bigint;
};

/**
 * Decide whether a payment should be attested.
 *
 * Deliberately pure: every rejection is a value rather than an exception or a
 * log line, so the reasons are testable and a caller can surface them to a
 * depositor whose deposit is stuck.
 */
export function evaluate(
  payment: MinaPayment,
  chainHeight: number,
  policy: AttestorPolicy,
  minaSenderPacked: Hex,
  nonce: bigint,
): Decision {
  if (payment.to !== policy.bridgeAddress) {
    return { ok: false, reason: 'payment was not sent to the bridge account' };
  }

  const depth = chainHeight - payment.blockHeight;
  if (depth < policy.confirmations) {
    return { ok: false, reason: `only ${depth} confirmations, need ${policy.confirmations}` };
  }

  if (payment.amountNanomina < policy.minAmountNanomina) {
    return { ok: false, reason: 'amount below the minimum' };
  }

  // An upper bound is not paranoia: this key can mint, so capping what a single
  // signature is worth bounds the damage if the watcher is ever fooled.
  if (payment.amountNanomina > policy.maxAmountNanomina) {
    return { ok: false, reason: 'amount above the per-deposit ceiling' };
  }

  const recipient = recipientFromMemo(payment.memo);
  if (recipient === null) {
    return { ok: false, reason: 'memo does not contain a Flare address' };
  }

  return {
    ok: true,
    target: {
      minaSender: minaSenderPacked,
      recipient,
      amountNanomina: payment.amountNanomina,
      nonce,
    },
  };
}

/**
 * The digest the attestor signs.
 *
 * Must match `MinaPortBridge.claimWithMinaSignature` byte for byte: the
 * contract recomputes it from its own arguments, so a mismatch is not a subtle
 * bug but a deposit that can never be claimed.
 */
export function intentDigest(chainId: bigint, target: AttestationTarget): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint64' },
        { type: 'uint64' },
      ],
      [
        DEPOSIT_INTENT_DOMAIN,
        chainId,
        target.minaSender,
        target.recipient,
        target.amountNanomina,
        target.nonce,
      ],
    ),
  );
}
