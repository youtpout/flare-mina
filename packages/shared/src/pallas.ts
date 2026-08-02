import { PALLAS_FIELD_ORDER } from './constants.js';
import type { MinaPublicKeyParts } from './types.js';

/**
 * Pallas curve point decompression.
 *
 * A Mina public key travels as `(x, isOdd)`. Verifying a signature on Flare
 * needs the full point, and the Solidity verifier takes `y` as an argument
 * rather than deriving it — computing a square root on-chain would cost more
 * than the rest of the verification, since the Pallas modulus is `P ≡ 1 (mod 4)`
 * with 2-adicity 32, so the cheap `a^((P+1)/4)` identity does not apply.
 *
 * So the caller supplies `y`, and this is where it comes from. Supplying it is
 * free of trust: the contract checks `y² == x³ + 5` and the parity bit, which
 * together admit exactly one value.
 *
 * Implemented with Tonelli-Shanks rather than by pulling in o1js, which would
 * add megabytes to a browser bundle for one square root.
 */

const P = PALLAS_FIELD_ORDER;
/** Curve parameter: Pallas is `y² = x³ + 5`. */
const B = 5n;

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function powMod(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

/**
 * Modular square root via Tonelli-Shanks.
 *
 * Returns `null` when `a` is a quadratic non-residue, i.e. when no point on the
 * curve has this x-coordinate.
 */
export function sqrtMod(a: bigint): bigint | null {
  const n = mod(a);
  if (n === 0n) return 0n;

  // Euler's criterion: a residue satisfies a^((P-1)/2) == 1.
  if (powMod(n, (P - 1n) / 2n) !== 1n) return null;

  // Factor P - 1 = q * 2^s with q odd.
  let q = P - 1n;
  let s = 0n;
  while ((q & 1n) === 0n) {
    q >>= 1n;
    s += 1n;
  }

  // Any non-residue works as the generator of the 2-Sylow subgroup.
  let z = 2n;
  while (powMod(z, (P - 1n) / 2n) !== P - 1n) z += 1n;

  let m = s;
  let c = powMod(z, q);
  let t = powMod(n, q);
  let r = powMod(n, (q + 1n) / 2n);

  while (t !== 1n) {
    // Smallest i with t^(2^i) == 1.
    let i = 0n;
    let squared = t;
    while (squared !== 1n) {
      squared = (squared * squared) % P;
      i += 1n;
      if (i === m) return null; // unreachable for a residue; guards an infinite loop
    }

    const b = powMod(c, 1n << (m - i - 1n));
    m = i;
    c = (b * b) % P;
    t = (t * c) % P;
    r = (r * b) % P;
  }

  return r;
}

export type PallasPoint = {
  x: bigint;
  y: bigint;
  isOdd: boolean;
};

/**
 * Recover the full curve point of a Mina public key.
 *
 * Throws when `x` is not the x-coordinate of any Pallas point — that is not a
 * recoverable condition, it means the key is malformed.
 */
export function decompressPublicKey(parts: MinaPublicKeyParts): PallasPoint {
  const x = BigInt(parts.x);
  if (x >= P) throw new Error('x is not a valid Pallas field element');

  const ySquared = mod(mod(x * x) * x + B);
  const root = sqrtMod(ySquared);
  if (root === null) throw new Error('x is not on the Pallas curve');

  // sqrt returns an arbitrary root; pick the one with the requested parity.
  const y = (root & 1n) === (parts.isOdd ? 1n : 0n) ? root : P - root;

  return { x, y, isOdd: parts.isOdd };
}

/** True when `(x, y)` satisfies the curve equation. */
export function isOnCurve(x: bigint, y: bigint): boolean {
  return mod(y * y) === mod(mod(x * x) * x + B);
}
