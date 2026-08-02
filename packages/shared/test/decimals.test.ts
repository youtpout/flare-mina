import { describe, expect, it } from 'vitest';
import {
  MAX_BRIDGEABLE_DECIMALS,
  bridgePlanFor,
  maxRepresentableSupply,
  roundDownToWrappable,
  wrappingDust,
} from '../src/index.js';

describe('bridge decimal policy', () => {
  it('lets real assets cross unchanged, keeping exact parity', () => {
    // USD₮0 and FXRP: 6 decimals on Flare, 6 decimals on Mina.
    for (const decimals of [0, 6, 8, 9]) {
      expect(bridgePlanFor(decimals)).toEqual({ kind: 'direct', decimals });
    }
  });

  it('requires WETH to be wrapped', () => {
    expect(bridgePlanFor(18)).toEqual({
      kind: 'wrap',
      fromDecimals: 18,
      toDecimals: 9,
      scale: 1_000_000_000n,
    });
  });

  it('explains why 9 is the ceiling', () => {
    // At 18 decimals a UInt64 holds 18 whole tokens: WETH is unrepresentable.
    expect(maxRepresentableSupply(18)).toBe(18n);
    // At 12 it holds ~18M, below ETH's circulating supply — still too tight.
    expect(maxRepresentableSupply(12)).toBeLessThan(20_000_000n);
    // At 9 it holds ~18 billion, and at 6 ~18 trillion.
    expect(maxRepresentableSupply(9)).toBeGreaterThan(18_000_000_000n);
    expect(maxRepresentableSupply(6)).toBeGreaterThan(18_000_000_000_000n);
  });

  it('never rounds a directly-bridgeable amount', () => {
    const amount = 123_456_789n;
    for (let d = 0; d <= MAX_BRIDGEABLE_DECIMALS; d++) {
      expect(roundDownToWrappable(amount, d)).toBe(amount);
      expect(wrappingDust(amount, d)).toBe(0n);
    }
  });

  it('reports the dust a wrap would discard', () => {
    const amount = 10n ** 18n + 123_456_789n;
    expect(wrappingDust(amount, 18)).toBe(123_456_789n);
    expect(roundDownToWrappable(amount, 18)).toBe(10n ** 18n);
    expect(roundDownToWrappable(amount, 18) % 1_000_000_000n).toBe(0n);
  });

  it('rejects implausible decimals rather than guessing', () => {
    expect(() => bridgePlanFor(-1)).toThrow(/implausible/);
    expect(() => bridgePlanFor(1.5)).toThrow(/implausible/);
    expect(() => bridgePlanFor(200)).toThrow(/implausible/);
  });
});
