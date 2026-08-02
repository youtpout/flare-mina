import { describe, expect, it } from 'vitest';
import { decompressPublicKey, isOnCurve, parseMinaAddress, sqrtMod } from '../src/index.js';

/**
 * Vectors from o1js: `PrivateKey.fromBigInt(n).toPublicKey().toGroup()` gives
 * both coordinates, so the y this module derives can be checked against the
 * reference rather than only against the curve equation.
 */
const VECTORS = [
  {
    base58: 'B62qjU6vUcjF257tP5njHUtYkVyQvMapJ5CmMVSLQW9NL8unLkcdJza',
    x: 0x1c0ac344a984ffd469d64699d920b83ebaf752b16d08f31345067060c8cb3c1en,
    y: 0x3c83e9d5746187c2dcdf51719e64a67f6481e28cacac4c35d37718b1e7e0d42en,
    isOdd: false,
  },
  {
    base58: 'B62qnVNBbSq6z3K98LpApQtGMpBjEzTgCS17JJDqtsG5WcGgGsEedJE',
    x: 0x1f3a6f5835be24dcadde6e2a94879da1a9ea870d9a2126dca03618b78d436678n,
    y: 0x1deb2532ade6336f2ef5eba65d5e433b978fb9e3c3ad8f8365a14799cf53d402n,
    isOdd: false,
  },
];

describe('pallas point decompression', () => {
  it('recovers the y o1js reports', () => {
    for (const v of VECTORS) {
      const point = decompressPublicKey(parseMinaAddress(v.base58));
      expect(point.x).toBe(v.x);
      expect(point.y).toBe(v.y);
      expect(point.isOdd).toBe(v.isOdd);
    }
  });

  it('lands on the curve', () => {
    for (const v of VECTORS) {
      const p = decompressPublicKey(parseMinaAddress(v.base58));
      expect(isOnCurve(p.x, p.y)).toBe(true);
    }
  });

  it('respects the parity bit', () => {
    const { x } = VECTORS[0]!;
    const even = decompressPublicKey({ x: `0x${x.toString(16).padStart(64, '0')}`, isOdd: false });
    const odd = decompressPublicKey({ x: `0x${x.toString(16).padStart(64, '0')}`, isOdd: true });

    expect(even.y % 2n).toBe(0n);
    expect(odd.y % 2n).toBe(1n);
    // The two roots are negatives of one another.
    expect(isOnCurve(odd.x, odd.y)).toBe(true);
  });

  it('rejects an x that is on no curve point', () => {
    // x = 0 gives y² = 5, a non-residue in the Pallas base field.
    expect(() => decompressPublicKey({ x: `0x${'0'.repeat(64)}`, isOdd: false })).toThrow(/curve/);
  });

  it('reports non-residues rather than returning a wrong root', () => {
    expect(sqrtMod(5n)).toBeNull();
    const four = sqrtMod(4n);
    expect(four === 2n || four === undefined ? four : four).toBeDefined();
    expect((four! * four!) % 28948022309329048855892746252171976963363056481941560715954676764349967630337n).toBe(4n);
  });
});
