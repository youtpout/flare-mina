import { verifyTypedData, type Hex, type TypedDataDomain } from 'viem';
import {
  LINK_DOMAIN_NAME,
  LINK_DOMAIN_VERSION,
  LINK_EXPIRY_WINDOW_SECONDS,
} from './constants.js';
import { isValidMinaAddress } from './minaAddress.js';
import type { LinkAccounts, SignedAccountLink } from './types.js';

/**
 * Account linking.
 *
 * A link is a claim that "this Flare address and this Mina address are
 * controlled by the same user". It is proven by TWO signatures over the SAME
 * canonical payload — one EIP-712 signature from the EVM account, one Mina
 * Schnorr signature from the Snap. Neither key is ever reused across chains.
 *
 * The payload is bound to:
 *   - the Flare chain id      -> a link signed for Coston2 is invalid on Flare
 *   - the Mina network id     -> a devnet link is invalid on mainnet
 *   - a nonce                 -> replay protection
 *   - an expiry               -> limits the window a leaked signature is useful
 *
 * For the MVP the link is stored off-chain by the frontend/relayer, but the
 * EIP-712 struct is already in the exact shape a future `AccountRegistry`
 * contract would verify on-chain, so no re-signing is needed later.
 */

export const LINK_ACCOUNTS_TYPES = {
  LinkAccounts: [
    { name: 'flareAddress', type: 'address' },
    { name: 'minaPublicKey', type: 'string' },
    { name: 'flareChainId', type: 'uint256' },
    { name: 'minaNetworkId', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
  ],
} as const;

/**
 * EIP-712 domain for the link payload.
 *
 * `verifyingContract` is intentionally omitted: for the MVP the link is not
 * verified by a contract. When the on-chain registry ships, adding it here is
 * a deliberate, versioned change (bump `LINK_DOMAIN_VERSION`).
 */
export function linkDomain(chainId: bigint): TypedDataDomain {
  return {
    name: LINK_DOMAIN_NAME,
    version: LINK_DOMAIN_VERSION,
    chainId: Number(chainId),
  };
}

/** Build a link payload with a fresh expiry. */
export function buildLinkPayload(params: {
  flareAddress: LinkAccounts['flareAddress'];
  minaPublicKey: string;
  flareChainId: bigint;
  minaNetworkId: string;
  nonce: bigint;
  nowSeconds?: bigint;
}): LinkAccounts {
  const now = params.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  return {
    flareAddress: params.flareAddress,
    minaPublicKey: params.minaPublicKey,
    flareChainId: params.flareChainId,
    minaNetworkId: params.minaNetworkId,
    nonce: params.nonce,
    expiry: now + BigInt(LINK_EXPIRY_WINDOW_SECONDS),
  };
}

/**
 * Canonical string the Mina Snap signs.
 *
 * Mina's `signMessage` takes a UTF-8 string, so the payload is serialised in a
 * fixed field order with explicit labels. This is NOT ad-hoc formatting: any
 * change to this function invalidates every previously issued link, so it is
 * versioned by the leading tag.
 */
export function minaLinkMessage(payload: LinkAccounts): string {
  return [
    'MinaPort.LinkAccounts.v1',
    `flareAddress=${payload.flareAddress.toLowerCase()}`,
    `minaPublicKey=${payload.minaPublicKey}`,
    `flareChainId=${payload.flareChainId.toString()}`,
    `minaNetworkId=${payload.minaNetworkId}`,
    `nonce=${payload.nonce.toString()}`,
    `expiry=${payload.expiry.toString()}`,
  ].join('\n');
}

export type LinkValidationResult = { valid: true } | { valid: false; reason: string };

/** Structural checks that do not require any cryptography. */
export function validateLinkPayload(
  payload: LinkAccounts,
  opts: { expectedChainId?: bigint; expectedMinaNetworkId?: string; nowSeconds?: bigint } = {},
): LinkValidationResult {
  const now = opts.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));

  if (!isValidMinaAddress(payload.minaPublicKey)) {
    return { valid: false, reason: 'invalid Mina public key' };
  }
  if (payload.expiry <= now) {
    return { valid: false, reason: 'link payload expired' };
  }
  if (opts.expectedChainId !== undefined && payload.flareChainId !== opts.expectedChainId) {
    return { valid: false, reason: 'chain id mismatch' };
  }
  if (
    opts.expectedMinaNetworkId !== undefined &&
    payload.minaNetworkId !== opts.expectedMinaNetworkId
  ) {
    return { valid: false, reason: 'Mina network mismatch' };
  }
  return { valid: true };
}

/**
 * Verify the EVM half of the link.
 *
 * Returns `false` for malformed signatures rather than throwing: this runs on
 * relayer-facing input, and a caller-supplied byte string must never be able to
 * turn a validation check into an unhandled exception.
 */
export async function verifyFlareLinkSignature(
  payload: LinkAccounts,
  signature: Hex,
): Promise<boolean> {
  try {
    return await verifyTypedDataStrict(payload, signature);
  } catch {
    return false;
  }
}

async function verifyTypedDataStrict(payload: LinkAccounts, signature: Hex): Promise<boolean> {
  return verifyTypedData({
    address: payload.flareAddress,
    domain: linkDomain(payload.flareChainId),
    types: LINK_ACCOUNTS_TYPES,
    primaryType: 'LinkAccounts',
    message: {
      flareAddress: payload.flareAddress,
      minaPublicKey: payload.minaPublicKey,
      flareChainId: payload.flareChainId,
      minaNetworkId: payload.minaNetworkId,
      nonce: payload.nonce,
      expiry: payload.expiry,
    },
    signature,
  });
}

/**
 * Verify the Mina half of the link.
 *
 * Schnorr verification over Pallas is implemented by `mina-signer`, which is a
 * heavy dependency we do not want in the browser bundle of every consumer. The
 * verifier is therefore injected: `@minaport/bridge-sdk` wires in `mina-signer`
 * on the relayer side, and the frontend can pass a no-op checker when it only
 * needs to display the link.
 */
export type MinaSignatureVerifier = (args: {
  message: string;
  publicKey: string;
  signature: { field: string; scalar: string };
  networkId: string;
}) => boolean | Promise<boolean>;

export async function verifyMinaLinkSignature(
  payload: LinkAccounts,
  signature: { field: string; scalar: string },
  verifier: MinaSignatureVerifier,
): Promise<boolean> {
  return verifier({
    message: minaLinkMessage(payload),
    publicKey: payload.minaPublicKey,
    signature,
    networkId: payload.minaNetworkId,
  });
}

/** Full verification: structure + both signatures. */
export async function verifyAccountLink(
  link: SignedAccountLink,
  minaVerifier: MinaSignatureVerifier,
  opts: { expectedChainId?: bigint; expectedMinaNetworkId?: string; nowSeconds?: bigint } = {},
): Promise<LinkValidationResult> {
  const structural = validateLinkPayload(link.payload, opts);
  if (!structural.valid) return structural;

  if (!(await verifyFlareLinkSignature(link.payload, link.flareSignature))) {
    return { valid: false, reason: 'invalid Flare (EIP-712) signature' };
  }
  if (!(await verifyMinaLinkSignature(link.payload, link.minaSignature, minaVerifier))) {
    return { valid: false, reason: 'invalid Mina (Schnorr) signature' };
  }
  return { valid: true };
}
