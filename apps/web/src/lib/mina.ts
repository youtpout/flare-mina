import { keccak256, encodeAbiParameters, toHex, type Address, type Hex } from 'viem';

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
  signFields(args: { message: (string | bigint)[] }): Promise<{
    data: unknown;
    publicKey: string;
    signature: { field: string; scalar: string };
  }>;
};

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
 * Field encoding of an authorization — exactly what the contracts recompute.
 *
 * Mirrors `MinaAuthRegistry.encodeAuthorization`. `actionHash` is split across
 * two field elements because a 256-bit digest does not fit in one ~254-bit
 * Pallas field without silently reducing, which would let two distinct actions
 * share an encoding.
 */
export function authorizationFields(params: {
  chainId: bigint;
  target: Address;
  actionHash: Hex;
  nonce: bigint;
  expiry: bigint;
}): string[] {
  const action = BigInt(params.actionHash);
  return [
    params.chainId,
    BigInt(params.target),
    action >> 128n,
    action & ((1n << 128n) - 1n),
    params.nonce,
    params.expiry,
  ].map(String);
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

/** Domain tag separating a batch from a lone call. */
const BATCH_DOMAIN = keccak256(toHex('MinaAccount.Batch.v1'));

/** Commitment to an ordered batch, mirroring `MinaAccount.batchHash`. */
export function batchHash(calls: { target: Address; value: bigint; data: Hex }[]): Hex {
  const items = calls.map((c) => callHash(c.target, c.value, c.data));
  return keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32[]' }], [BATCH_DOMAIN, items]),
  );
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
  return {
    publicKey: result.publicKey,
    field: result.signature.field,
    scalar: result.signature.scalar,
  };
}
