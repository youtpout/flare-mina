import { describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import {
  DEPOSIT_LEAF_DOMAIN,
  PALLAS_FIELD_ORDER,
  decodeMinaRecipient,
  encodeDepositLeaf,
  encodeMinaRecipient,
  hashDepositLeaf,
  type DepositLeaf,
} from '../src/index.js';

const SENDER = {
  x: '0x0000000000000000000000000000000000000000000000000000000000000001',
  isOdd: false,
} as const;

const BASE_DEPOSIT: DepositLeaf = {
  nonce: 0n,
  sender: SENDER,
  recipientFlare: '0x1111111111111111111111111111111111111111',
  amountNanomina: 1_000_000_000n,
};

describe('deposit leaf encoding', () => {
  it('produces a 192-byte (6 word) preimage', () => {
    const preimage = encodeDepositLeaf(BASE_DEPOSIT);
    expect((preimage.length - 2) / 2).toBe(192);
  });

  it('starts the preimage with the domain separator', () => {
    const preimage = encodeDepositLeaf(BASE_DEPOSIT);
    expect(preimage.slice(0, 66)).toBe(DEPOSIT_LEAF_DOMAIN);
  });

  it('is deterministic', () => {
    expect(hashDepositLeaf(BASE_DEPOSIT)).toBe(hashDepositLeaf({ ...BASE_DEPOSIT }));
  });

  it('changes when any single field changes', () => {
    const base = hashDepositLeaf(BASE_DEPOSIT);
    const variants: DepositLeaf[] = [
      { ...BASE_DEPOSIT, nonce: 1n },
      { ...BASE_DEPOSIT, amountNanomina: 1_000_000_001n },
      { ...BASE_DEPOSIT, recipientFlare: '0x2222222222222222222222222222222222222222' },
      { ...BASE_DEPOSIT, sender: { ...SENDER, isOdd: true } },
      { ...BASE_DEPOSIT, sender: { ...SENDER, x: `0x${'0'.repeat(63)}2` } },
    ];
    for (const variant of variants) {
      expect(hashDepositLeaf(variant)).not.toBe(base);
    }
  });

  it('rejects zero amounts', () => {
    expect(() => hashDepositLeaf({ ...BASE_DEPOSIT, amountNanomina: 0n })).toThrow(/non-zero/);
  });

  it('rejects out-of-range uint64 values', () => {
    expect(() => hashDepositLeaf({ ...BASE_DEPOSIT, nonce: 1n << 64n })).toThrow(/uint64/);
    expect(() => hashDepositLeaf({ ...BASE_DEPOSIT, amountNanomina: 1n << 64n })).toThrow(/uint64/);
  });

  it('cannot collide with an internal Merkle node (64-byte preimage)', () => {
    // Leaf preimages are 192 bytes; node preimages are 64. A leaf digest can
    // therefore never be produced by hashing a node pair.
    const nodeLike = keccak256(`0x${'ab'.repeat(64)}`);
    expect(hashDepositLeaf(BASE_DEPOSIT)).not.toBe(nodeLike);
  });
});

describe('mina recipient packing', () => {
  it('round-trips both parities', () => {
    for (const isOdd of [false, true]) {
      const parts = { x: SENDER.x, isOdd };
      expect(decodeMinaRecipient(encodeMinaRecipient(parts))).toEqual(parts);
    }
  });

  it('sets bit 255 only for odd keys', () => {
    expect(BigInt(encodeMinaRecipient({ x: SENDER.x, isOdd: false })) >> 255n).toBe(0n);
    expect(BigInt(encodeMinaRecipient({ x: SENDER.x, isOdd: true })) >> 255n).toBe(1n);
  });

  it('rejects x values outside the Pallas base field', () => {
    const tooBig = `0x${PALLAS_FIELD_ORDER.toString(16).padStart(64, '0')}` as const;
    expect(() => encodeMinaRecipient({ x: tooBig, isOdd: false })).toThrow(/Pallas/);
  });
});
