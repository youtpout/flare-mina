import { describe, expect, it } from 'vitest';
import { parseMinaSignature, toFieldSignature } from '../src/minaSignature.js';

/**
 * Vectors from `mina-signer` 4.1.0, each signature captured in both forms it
 * exists in: the base58 string its public `signFields` returns, and the
 * `(r, s)` pair its internal `sign` returns. The Solidity verifier consumes the
 * second; every wallet hands back the first.
 *
 * That gap is what this module exists to close, and it cost a working deposit
 * to find: the frontend read `signature.field` off a string, got `undefined`,
 * and reported `Cannot convert undefined to a BigInt` — which says nothing
 * about wallets or encodings.
 */
const VECTORS = [
  {
    base58:
      '7mXWFXbz2DFB4dLhw2BehkwQyi5pFWBYrrcWuzbZt86Z1hzxtQyjyfkS9evr9TGnwNdbA5FRtD8rKNLXKwBqXTpkv8akNU5M',
    field: 17470378610623523967889808941267043032391258309377741419454858561233486933745n,
    scalar: 7024110982104526274042035989107611196043264813861132722247276142018443601381n,
  },
  {
    base58:
      '7mXFsmkxqJ6mfxqTcWDDBKYgBwe1BN7rkc22NoGUAayjSCoXUGMjhjsjLkEVMkhFx8QGZsB4vLuzrb2ahi9Z6THWkm6JxmfJ',
    field: 24368404277959840106679155626967930869846403055396810349079288616249443880324n,
    scalar: 22496719225677619648969188954427666887015039502688610062619527332665447755876n,
  },
  {
    base58:
      '7mXXFZ769hr8rdsDuVJYd6pemJuHrB3wVKbvULmhTGqYnSez86mcrQxxoT9iUk4k1sQVfwWab6sTW68NLtjYVPWKwJPVjNZb',
    field: 2946287801567208594933582893304892623252031236821196052769360888865220695033n,
    scalar: 20766929819394817410508331966474522284316584242685455777828063917669918015276n,
  },
];

describe('parseMinaSignature', () => {
  it.each(VECTORS)('decodes $base58 to the same (r, s) mina-signer produced', (vector) => {
    expect(parseMinaSignature(vector.base58)).toEqual({
      field: vector.field,
      scalar: vector.scalar,
    });
  });

  it('rejects a corrupted signature rather than returning wrong scalars', () => {
    const vector = VECTORS[0]!;
    // Flip one character in the middle. Silently decoding this would produce a
    // signature that fails on chain for no visible reason.
    const corrupted = `${vector.base58.slice(0, 40)}${
      vector.base58[40] === 'a' ? 'b' : 'a'
    }${vector.base58.slice(41)}`;

    expect(() => parseMinaSignature(corrupted)).toThrow(/checksum|length|version/);
  });

  it('rejects a public key handed in where a signature was expected', () => {
    expect(() =>
      parseMinaSignature('B62qoN7YUujNaPyZxXUPQUvLVA98qSZFxbNezzAzYSRMj2aBfMjjm3X'),
    ).toThrow(/length|version/);
  });
});

describe('toFieldSignature', () => {
  it('accepts the base58 string wallets return', () => {
    const vector = VECTORS[0]!;
    expect(toFieldSignature(vector.base58)).toEqual({
      field: vector.field,
      scalar: vector.scalar,
    });
  });

  it('accepts the object form, decimal strings or bigints', () => {
    const vector = VECTORS[1]!;
    expect(
      toFieldSignature({ field: vector.field.toString(), scalar: vector.scalar.toString() }),
    ).toEqual({ field: vector.field, scalar: vector.scalar });

    expect(toFieldSignature({ field: vector.field, scalar: vector.scalar })).toEqual({
      field: vector.field,
      scalar: vector.scalar,
    });
  });

  /**
   * The failure this module was written for. `BigInt(undefined)` reports
   * `Cannot convert undefined to a BigInt`, which sends you looking at numbers
   * instead of at the wallet.
   */
  it('says what went wrong when a wallet returns nothing usable', () => {
    expect(() => toFieldSignature(undefined)).toThrow(/no signature/);
    expect(() => toFieldSignature({} as never)).toThrow(/without field\/scalar/);
  });
});
