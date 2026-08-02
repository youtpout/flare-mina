import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  FLARE_CHAINS,
  LINK_ACCOUNTS_TYPES,
  MINA_NETWORKS,
  buildLinkPayload,
  linkDomain,
  minaLinkMessage,
  validateLinkPayload,
  verifyAccountLink,
  verifyFlareLinkSignature,
  type LinkAccounts,
} from '../src/index.js';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
/** Real o1js-derived public key (see minaAddress.test.ts for the vector set). */
const MINA_ADDRESS = 'B62qjU6vUcjF257tP5njHUtYkVyQvMapJ5CmMVSLQW9NL8unLkcdJza';
const NOW = 1_700_000_000n;

function payload(overrides: Partial<LinkAccounts> = {}): LinkAccounts {
  return {
    ...buildLinkPayload({
      flareAddress: account.address,
      minaPublicKey: MINA_ADDRESS,
      flareChainId: BigInt(FLARE_CHAINS.coston2),
      minaNetworkId: MINA_NETWORKS.devnet,
      nonce: 1n,
      nowSeconds: NOW,
    }),
    ...overrides,
  };
}

async function signFlare(p: LinkAccounts) {
  return account.signTypedData({
    domain: linkDomain(p.flareChainId),
    types: LINK_ACCOUNTS_TYPES,
    primaryType: 'LinkAccounts',
    message: p,
  });
}

describe('link payload', () => {
  it('is bound to chain id and Mina network', () => {
    const p = payload();
    expect(validateLinkPayload(p, { expectedChainId: 114n, nowSeconds: NOW })).toEqual({
      valid: true,
    });
    expect(validateLinkPayload(p, { expectedChainId: 14n, nowSeconds: NOW })).toMatchObject({
      valid: false,
      reason: 'chain id mismatch',
    });
    expect(
      validateLinkPayload(p, { expectedMinaNetworkId: 'mina:mainnet', nowSeconds: NOW }),
    ).toMatchObject({ valid: false, reason: 'Mina network mismatch' });
  });

  it('expires', () => {
    const p = payload();
    expect(validateLinkPayload(p, { nowSeconds: p.expiry + 1n })).toMatchObject({
      valid: false,
      reason: 'link payload expired',
    });
  });

  it('rejects a malformed Mina public key', () => {
    expect(
      validateLinkPayload(payload({ minaPublicKey: 'B62notavalidkey' }), { nowSeconds: NOW }),
    ).toMatchObject({ valid: false, reason: 'invalid Mina public key' });
  });

  it('serialises the Mina message deterministically and versioned', () => {
    const message = minaLinkMessage(payload());
    expect(message.split('\n')[0]).toBe('MinaPort.LinkAccounts.v1');
    expect(message).toBe(minaLinkMessage(payload()));
  });
});

describe('flare signature', () => {
  it('verifies a valid EIP-712 signature', async () => {
    const p = payload();
    expect(await verifyFlareLinkSignature(p, await signFlare(p))).toBe(true);
  });

  it('rejects a signature made for a different chain id', async () => {
    const signed = payload();
    const signature = await signFlare(signed);
    // Same struct fields, different domain chain id -> different digest.
    expect(await verifyFlareLinkSignature({ ...signed, flareChainId: 14n }, signature)).toBe(false);
  });

  it('rejects a signature over tampered fields', async () => {
    const p = payload();
    const signature = await signFlare(p);
    expect(await verifyFlareLinkSignature({ ...p, nonce: 2n }, signature)).toBe(false);
  });
});

describe('full account link', () => {
  it('requires both signatures to be valid', async () => {
    const p = payload();
    const flareSignature = await signFlare(p);
    const minaSignature = { field: '1', scalar: '2' };

    const accept = () => true;
    const reject = () => false;

    await expect(
      verifyAccountLink({ payload: p, flareSignature, minaSignature }, accept, { nowSeconds: NOW }),
    ).resolves.toEqual({ valid: true });

    await expect(
      verifyAccountLink({ payload: p, flareSignature, minaSignature }, reject, { nowSeconds: NOW }),
    ).resolves.toMatchObject({ valid: false, reason: 'invalid Mina (Schnorr) signature' });

    await expect(
      verifyAccountLink(
        { payload: p, flareSignature: `0x${'00'.repeat(65)}`, minaSignature },
        accept,
        { nowSeconds: NOW },
      ),
    ).resolves.toMatchObject({ valid: false, reason: 'invalid Flare (EIP-712) signature' });
  });
});
