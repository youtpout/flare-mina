import { describe, expect, it } from 'vitest';
import {
  formatMinaAddress,
  isValidMinaAddress,
  parseMinaAddress,
  type MinaPublicKeyParts,
} from '../src/index.js';

/**
 * Reference vectors generated with o1js:
 *
 *   PrivateKey.fromBigInt(n).toPublicKey() -> { toBase58(), toGroup().x, isOdd }
 *
 * These pin our dependency-free base58check codec to the canonical o1js
 * implementation, including the little-endian -> big-endian flip on `x`.
 * `packages/mina-contracts` re-derives them from o1js directly, so a future
 * o1js change that altered the encoding would break that test too.
 */
const VECTORS: Array<MinaPublicKeyParts & { base58: string }> = [
  {
    base58: 'B62qjU6vUcjF257tP5njHUtYkVyQvMapJ5CmMVSLQW9NL8unLkcdJza',
    x: '0x1c0ac344a984ffd469d64699d920b83ebaf752b16d08f31345067060c8cb3c1e',
    isOdd: false,
  },
  {
    base58: 'B62qo3WSJ3ZVsDjQ7s5bDvkv2coL3QhkSexntSYEvczEtSWNtdt3f8X',
    x: '0x2d16046352007487a6722508e332a45b399535ef6bf8637ee4f106658647ef88',
    isOdd: false,
  },
  {
    base58: 'B62qrs6u5RAKUZRBrNenZHNqZ4r6suTTLutsMjmjmSp3XDGvLqX48fb',
    x: '0x124d587cba4cb1ce2f60fb1610e8ab6f5b0eff5de856446e4fc9f254b95deefa',
    isOdd: true,
  },
];

describe('mina base58 address codec', () => {
  it('decodes o1js reference vectors', () => {
    for (const { base58, x, isOdd } of VECTORS) {
      expect(parseMinaAddress(base58)).toEqual({ x, isOdd });
    }
  });

  it('re-encodes o1js reference vectors', () => {
    for (const { base58, x, isOdd } of VECTORS) {
      expect(formatMinaAddress({ x, isOdd })).toBe(base58);
    }
  });

  it('round-trips', () => {
    for (const { base58 } of VECTORS) {
      expect(formatMinaAddress(parseMinaAddress(base58))).toBe(base58);
    }
  });

  it('rejects a corrupted checksum', () => {
    const [first] = VECTORS;
    const corrupted = `${first!.base58.slice(0, -1)}${first!.base58.endsWith('a') ? 'b' : 'a'}`;
    expect(() => parseMinaAddress(corrupted)).toThrow();
    expect(isValidMinaAddress(corrupted)).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(isValidMinaAddress('B62notavalidkey')).toBe(false);
    expect(isValidMinaAddress('')).toBe(false);
    expect(isValidMinaAddress('0x1234')).toBe(false);
  });
});
