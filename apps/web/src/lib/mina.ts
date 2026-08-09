import { keccak256, encodeAbiParameters, toHex, type Address, type Hex } from 'viem';
import { toFieldSignature } from '@minaport/shared';

/**
 * Mina wallet access and authorization signing.
 *
 * Talks to whatever injects `window.mina` — Auro and Pallad both do, and the
 * MetaMask Mina Snap exposes the same surface. We only need two calls:
 * `requestAccounts` and `signFields`.
 */

export type MinaProvider = {
  requestAccounts(): Promise<string[]>;
  getAccounts?(): Promise<string[]>;
  /**
   * Sign a list of field elements.
   *
   * `signature` is a base58check string in every wallet checked, and in
   * `mina-signer`'s own public API — the `{ field, scalar }` object form only
   * comes out of its internal `sign`. Typed as both because the boundary
   * should accept either; `toFieldSignature` normalises.
   */
  signFields(args: { message: (string | bigint)[] }): Promise<{
    data: unknown;
    publicKey: string;
    signature: string | { field: string; scalar: string };
  }>;
  /**
   * Sign a plain string.
   *
   * Optional: not every provider exposes it, and the app only uses it for the
   * readable-signature preview today. Deliberately not `signJsonMessage` — that
   * one lets the *wallet* serialise the payload, so two wallets can hash
   * different bytes for the same intent and a contract cannot rebuild either
   * with confidence.
   */
  signMessage?(args: { message: string }): Promise<{
    data: unknown;
    publicKey: string;
    signature: string | { field: string; scalar: string };
  }>;
  /**
   * Sign and broadcast a zkApp transaction the dApp built.
   *
   * The relayer produces the proof — a zkApp method call is a proof, and
   * putting o1js in this bundle would mean proving on the user's machine. It
   * costs no trust: `deposit` pulls funds through
   * `AccountUpdate.createSigned(sender)`, so nothing moves until this call
   * signs that exact account update.
   */
  sendTransaction(args: {
    transaction: string;
    feePayer?: { fee?: number; memo?: string };
  }): Promise<{ hash: string }>;

  /**
   * Account and network changes.
   *
   * Optional because not every injected provider implements it, and a wallet
   * that does not is still perfectly usable — the app just cannot follow a
   * switch it is never told about.
   *
   * `accountsChanged` carries the new list, empty when the wallet locks or the
   * site's permission is revoked.
   */
  on?(event: 'accountsChanged', handler: (accounts: string[]) => void): void;
  on?(event: 'chainChanged', handler: (chain: unknown) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
};

/**
 * What a built deposit commits to, read straight out of the transaction JSON.
 *
 * The relayer says what it built; this reads what it actually built. Parsing
 * the account updates needs no o1js — they are plain JSON — and it turns "did
 * the server put my address in the proof" from a question of trust into a
 * check.
 */
export function depositCommitment(
  transactionJson: string,
): { escrowedNanomina: bigint } | null {
  try {
    const tx = JSON.parse(transactionJson) as {
      accountUpdates?: { body?: { balanceChange?: { magnitude?: string; sgn?: string } } }[];
    };

    // The escrow's own update is the one whose balance goes up. Its magnitude
    // is what the depositor is actually parting with.
    for (const update of tx.accountUpdates ?? []) {
      const change = update.body?.balanceChange;
      if (change?.sgn === 'Positive' && change.magnitude !== undefined) {
        return { escrowedNanomina: BigInt(change.magnitude) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

declare global {
  interface Window {
    mina?: MinaProvider;
  }
}

export function getMinaProvider(): MinaProvider | null {
  if (typeof window === 'undefined') return null;
  return window.mina ?? null;
}

/**
 * What a Mina key is being asked to authorise.
 *
 * The first signed field, and the reason two features can never share a
 * signature: without it, an account authorization and a deposit intent are the
 * same seven fields separated only by their target addresses happening to
 * differ. Mirrors `SignaturePurpose.sol`.
 */
export const PURPOSE = {
  accountCall: 1n,
  accountBatch: 2n,
  depositIntent: 3n,
  releaseIntent: 4n,
} as const;

/**
 * Field encoding of an authorization — exactly what the contracts recompute.
 *
 * Mirrors `MinaAuthRegistry.encodeAuthorization`. `actionHash` is split across
 * two field elements because a 256-bit digest does not fit in one ~254-bit
 * Pallas field without silently reducing, which would let two distinct actions
 * share an encoding.
 */
export function authorizationFields(params: {
  purpose: bigint;
  chainId: bigint;
  target: Address;
  actionHash: Hex;
  nonce: bigint;
  expiry: bigint;
}): string[] {
  const action = BigInt(params.actionHash);
  return [
    params.purpose,
    params.chainId,
    BigInt(params.target),
    action >> 128n,
    action & ((1n << 128n) - 1n),
    params.nonce,
    params.expiry,
  ].map(String);
}

/** Names for the purpose tags, for the readable message below. */
const PURPOSE_NAME: Record<string, string> = {
  '1': 'call',
  '2': 'batch',
  '3': 'deposit',
  '4': 'release',
};

/**
 * The same authorization as text, for a wallet that can display what it signs.
 *
 * `signFields` renders in Auro as a column of raw decimals nobody can check.
 * This is the alternative: one string, signed with `signMessage`, which the
 * contract rebuilds from its own arguments the way it rebuilds the fields.
 *
 * Nothing here is prose the contract cannot verify. It is tempting to write
 * "send 1 USD₮0 to Alice", but the contract would have to be handed that
 * sentence to reconstruct the string — so the signature would cover the
 * sentence without tying it to the calldata, and a relayer could pair a
 * reassuring phrase with a different action. `action` therefore stays a digest:
 * opaque, and honest about it.
 *
 * Byte-for-byte stable, because the hash is over these exact bytes: lowercase
 * hex, decimal integers, `\n` separators, no trailing newline.
 */
export function authorizationMessage(params: {
  purpose: bigint;
  chainId: bigint;
  target: Address;
  actionHash: Hex;
  nonce: bigint;
  expiry: bigint;
}): string {
  const purpose = PURPOSE_NAME[params.purpose.toString()] ?? params.purpose.toString();
  return [
    'Flare x Mina',
    `purpose: ${purpose}`,
    `chain: ${params.chainId}`,
    `target: ${params.target.toLowerCase()}`,
    `action: ${params.actionHash.toLowerCase()}`,
    `nonce: ${params.nonce}`,
    `expires: ${params.expiry}`,
  ].join('\n');
}

/** Commitment to one call: `keccak256(abi.encode(target, value, keccak256(data)))`. */
export function callHash(target: Address, value: bigint, data: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
      [target, value, keccak256(data)],
    ),
  );
}

/** Domain tag for a deposit intent; mirrors `MinaPortBridge.DEPOSIT_INTENT_DOMAIN`. */
const DEPOSIT_INTENT_DOMAIN = keccak256(toHex('FlareXMina.DepositIntent.v1'));

/**
 * Commitment to a deposit, as the bridge recomputes it.
 *
 * The depositor signs this. It is what stops the attestor redirecting a deposit
 * or inflating it: recipient and amount are inside the signature, and the
 * contract checks that signature against Pallas on-chain.
 */
export function depositActionHash(recipient: Address, amountNanomina: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint64' }],
      [DEPOSIT_INTENT_DOMAIN, recipient, amountNanomina],
    ),
  );
}

/** Must match `AssetVault.RELEASE_INTENT_DOMAIN`. */
export const RELEASE_INTENT_DOMAIN = keccak256(toHex('FlareXMina.ReleaseIntent.v1'));

/**
 * What a holder signs to direct a burn back to Flare.
 *
 * Mirrors `AssetVault.releaseIntentFields`: the token is in here, so a
 * signature for one asset cannot release another.
 */
export function releaseActionHash(token: Address, recipient: Address, amount: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [RELEASE_INTENT_DOMAIN, token, recipient, amount],
    ),
  );
}

/**
 * Commitment to an ordered batch, mirroring `MinaAccount.batchHash`.
 *
 * No domain tag here: a batch and a lone call are already separated by their
 * purpose tags, which are signed first.
 */
export function batchHash(calls: { target: Address; value: bigint; data: Hex }[]): Hex {
  const items = calls.map((c) => callHash(c.target, c.value, c.data));
  return keccak256(encodeAbiParameters([{ type: 'bytes32[]' }], [items]));
}

export type MinaSignature = {
  publicKey: string;
  /** `r`, a base field element, as a decimal string. */
  field: string;
  /** `s`, a scalar, as a decimal string. */
  scalar: string;
};

/** Ask the wallet to sign an authorization. */
export async function signAuthorization(
  provider: MinaProvider,
  params: Parameters<typeof authorizationFields>[0],
): Promise<MinaSignature> {
  const result = await provider.signFields({ message: authorizationFields(params) });
  const { field, scalar } = toFieldSignature(result.signature);
  return { publicKey: result.publicKey, field: field.toString(), scalar: scalar.toString() };
}
