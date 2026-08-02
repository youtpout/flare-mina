import { describe, expect, it } from 'vitest';
import { isAddress } from 'viem';
import {
  COSTON2_TOKENS,
  FLARE_CHAINS,
  FLARE_CONTRACT_REGISTRY,
  availableTokens,
  defaultTokens,
  tokensRequiringWrapper,
} from '../src/index.js';

describe('default token list', () => {
  it('only exposes verified addresses', () => {
    for (const t of availableTokens(FLARE_CHAINS.coston2)) {
      expect(isAddress(t.address!), `${t.symbol} address`).toBe(true);
      expect(t.source.length).toBeGreaterThan(10);
    }
  });

  it('leaves unverified tokens null rather than guessing', () => {
    // A wrong address in a token list loses funds, so absence is the safe state.
    const unverified = COSTON2_TOKENS.filter((t) => t.address === null);
    expect(unverified.length).toBeGreaterThan(0);
    for (const t of unverified) {
      // Each absence must say WHY, so nobody "helpfully" fills one in from
      // an unverified source later.
      expect(t.source).toMatch(/not present|not deployed|no assetmanager|verify|resolve|filled in/i);
    }
  });

  /// Three tokens on Coston2 answer to some form of "USDT0". Picking by name
  /// would have been a coin flip with user funds on the outcome.
  it('carries the faucet USD₮0, identified by usage not by name', () => {
    const usdt = COSTON2_TOKENS.find((t) => t.symbol === 'USD₮0')!;
    expect(usdt.address).toBe('0xC1A5B41512496B80903D1f32d6dEa3a73212E71F');
    expect(usdt.decimals).toBe(6);
    expect(usdt.bridge.kind).toBe('direct');
    expect(usdt.source).toMatch(/holders|transfers/i);
  });

  it('carries FXRP, the bounty priority asset, verified on-chain', () => {
    const fxrp = COSTON2_TOKENS.find((t) => t.symbol === 'FXRP')!;
    expect(fxrp.address).toBe('0x0b6A3645c240605887a5532109323A3E12273dc7');
    expect(fxrp.decimals).toBe(6);
    // 6 decimals means it crosses to Mina untouched.
    expect(fxrp.bridge.kind).toBe('direct');
  });

  it('flags 18-decimal assets as needing a wrapper', () => {
    const wrapped = tokensRequiringWrapper(FLARE_CHAINS.coston2).map((t) => t.symbol);
    // WFLR is 18 decimals, which Mina's UInt64 cannot represent — the wrapper
    // is not a WETH special case.
    expect(wrapped).toContain('WC2FLR');
    expect(wrapped).toContain('WETH');
    expect(wrapped).not.toContain('FXRP');
    expect(wrapped).not.toContain('FMINA');
  });

  it('pins the canonical Flare registry, which is network-independent', () => {
    expect(FLARE_CONTRACT_REGISTRY).toBe('0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019');
  });

  it('returns nothing for an unknown chain', () => {
    expect(defaultTokens(1)).toEqual([]);
  });
});
