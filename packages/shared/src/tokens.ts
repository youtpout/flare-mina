import type { Address } from 'viem';
import { FLARE_CHAINS } from './constants.js';
import { bridgePlanFor, type BridgePlan } from './decimals.js';

/**
 * Default asset list.
 *
 * Swapping is deliberately unrestricted — `MinaAccount.execute` takes any target
 * and any calldata, so the account works with every DEX and every pair without
 * an allowlist, an adapter, or an upgrade. This list only decides what a wallet
 * shows first.
 *
 * Every address here was read from the chain, not from documentation: the Flare
 * contract registry was queried on Coston2 and each token's `symbol()` and
 * `decimals()` confirmed. Addresses that could not be verified are `null` rather
 * than guessed — a wrong address in a token list loses funds.
 */

/**
 * Canonical Flare contract registry.
 *
 * The same address on every Flare network, and the reason this file has so few
 * hardcoded values: everything else is resolved through it at runtime, so a
 * redeployment on Flare's side does not strand us on a stale constant.
 */
export const FLARE_CONTRACT_REGISTRY: Address =
  '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019';

/** Registry names for the Flare infrastructure this project uses. */
export const FLARE_CONTRACT_NAMES = {
  /** Wrapped native token (WFLR / WC2FLR). */
  wrappedNative: 'WNat',
  /** Price feeds, used for quoting and portfolio valuation. */
  ftso: 'FtsoV2',
  /** Signed Merkle roots — the basis of the Flare -> Mina return path. */
  relay: 'Relay',
  /** Data connector, for attesting external-chain events to Flare. */
  fdcHub: 'FdcHub',
  fdcVerification: 'FdcVerification',
  /** FXRP's asset manager; `fAsset()` on it yields the FXRP token. */
  fxrpAssetManager: 'AssetManagerFXRP',
} as const;

export type TokenInfo = {
  symbol: string;
  name: string;
  decimals: number;
  /** `null` when the token does not exist on this network, or is not verified. */
  address: Address | null;
  /** How this token reaches Mina — direct, or through a 9-decimal wrapper. */
  bridge: BridgePlan;
  /** Why the address is what it is, so nobody has to trust this file blindly. */
  source: string;
};

function token(
  symbol: string,
  name: string,
  decimals: number,
  address: Address | null,
  source: string,
): TokenInfo {
  return { symbol, name, decimals, address, bridge: bridgePlanFor(decimals), source };
}

/**
 * Coston2 (chain 114).
 *
 * Only FXRP exists as an FAsset here today; the registry lists a single
 * `AssetManagerFXRP` and no manager for BTC or DOGE. That is a property of the
 * testnet, not of the design — the list is resolved by name, so those appear
 * automatically once deployed.
 */
export const COSTON2_TOKENS: TokenInfo[] = [
  token(
    'FMINA',
    'Flare MINA',
    9,
    null,
    'Deployed by this project; filled in after deployment.',
  ),
  token(
    'FXRP',
    'FTestXRP',
    6,
    '0x0b6A3645c240605887a5532109323A3E12273dc7',
    'AssetManagerFXRP.fAsset() via the Flare contract registry; symbol() and decimals() confirmed on-chain.',
  ),
  token(
    'WC2FLR',
    'Wrapped Coston2 Flare',
    18,
    '0xC67DCE33D7A8efA5FfEB961899C73fe01bCe9273',
    'Registry name "WNat"; symbol() and decimals() confirmed on-chain.',
  ),
  token(
    'USD₮0',
    'USDT0 test',
    6,
    '0xC1A5B41512496B80903D1f32d6dEa3a73212E71F',
    'Distributed by the Coston2 faucet. Identified against three same-named ' +
      'impostors by usage rather than by name: 4,384 holders, and 36 of 50 ' +
      'recent transfers are exactly 10.000000 — the faucet\'s advertised ' +
      'per-address allowance. The look-alikes have 252 and 75 holders.',
  ),
  token(
    'WETH',
    'Wrapped Ether',
    18,
    null,
    'Not present on Coston2 at the time of writing. Verify before adding.',
  ),
  token(
    'FBTC',
    'Flare Bitcoin',
    8,
    null,
    'No AssetManagerFBTC in the Coston2 registry yet.',
  ),
];

/**
 * Flare mainnet (chain 14).
 *
 * Deliberately empty of addresses: none were verified against mainnet, and
 * guessing would be worse than leaving the list short. Resolve them the same way
 * — through the registry — before shipping anything that touches mainnet.
 */
export const FLARE_TOKENS: TokenInfo[] = [
  token('FMINA', 'Flare MINA', 9, null, 'Not deployed to mainnet.'),
  token('FXRP', 'FXRP', 6, null, 'Resolve via AssetManagerFXRP.fAsset().'),
  token('WFLR', 'Wrapped Flare', 18, null, 'Resolve via registry name "WNat".'),
];

export function defaultTokens(chainId: number): TokenInfo[] {
  switch (chainId) {
    case FLARE_CHAINS.coston2:
      return COSTON2_TOKENS;
    case FLARE_CHAINS.flare:
      return FLARE_TOKENS;
    default:
      return [];
  }
}

/** Tokens that are usable right now, i.e. have a verified address. */
export function availableTokens(chainId: number): TokenInfo[] {
  return defaultTokens(chainId).filter((t) => t.address !== null);
}

/** Tokens needing a 9-decimal wrapper before they can cross to Mina. */
export function tokensRequiringWrapper(chainId: number): TokenInfo[] {
  return defaultTokens(chainId).filter((t) => t.bridge.kind === 'wrap');
}
