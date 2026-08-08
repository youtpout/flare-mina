import type { Address } from 'viem';

/**
 * Deployment configuration.
 *
 * Every address here is live on Coston2 and is the one the README lists. They
 * are constants rather than environment variables on purpose: a demo that
 * silently points at nothing when a variable is unset is worse than one that
 * cannot be misconfigured.
 */

export const COSTON2 = {
  id: 114,
  name: 'Coston2',
  rpc: 'https://coston2-api.flare.network/ext/C/rpc',
  explorer: 'https://coston2-explorer.flare.network',
  nativeSymbol: 'C2FLR',
} as const;

export const CONTRACTS = {
  authRegistry: '0xcf12aCe3f7D13EE714D57ee22EfA14cbb662fc56',
  accountFactory: '0x2a2AcdD54B93675828028fb8108fACc0A387fe23',
  /** Locks Flare assets so they can be minted as fungible tokens on Mina. */
  assetVault: '0xa179E908C3F1156Edda0BD5f1A0B3b3f419f9F90',
  /**
   * C2FLR, rounded from 18 decimals to 9 so Mina's `UInt64` can hold a real
   * supply of it. The native token is not an ERC-20 and `WNat` is 18 decimals,
   * which caps at ~18.4 whole tokens on Mina.
   */
  wrappedC2flr: '0x6C790956D728ed82A75d2ec8D5c37F2e2F36b978',
  bridge: '0x871493412EDCcfE0d24f127E6Deb2B20AE5497aB',
  fmina: '0x4aFce36d468136eD9d880E28C99373F0C3d3f046',
  wrapperFactory: '0x98f0CA385dBe0724b4D9211fA4e515eB4d6848b7',
} as const satisfies Record<string, Address>;

/**
 * BlazeSwap. Three routers exist on Coston2 and only this one has an FXRP
 * pair — the other two return the zero address for it.
 */
export const DEX = {
  router: '0x440602f459D7Dd500a74528003e6A20A46d6e2A6',
  fxrpUsdtPair: '0xDD598473f738df117Ee331bc07172481db60acBE',
} as const satisfies Record<string, Address>;

export type TokenConfig = {
  symbol: string;
  address: Address;
  decimals: number;
  note?: string;
  /**
   * The chain's own coin rather than an ERC-20. `address` still holds the
   * wrapper, because that is what a pool is priced against — the router wraps
   * and unwraps around the swap itself, so nothing else has to know.
   */
  native?: boolean;
};

/**
 * Tokens shown by default.
 *
 * Swapping is not limited to these — the account executes any call, so any pair
 * on any DEX works. This list only decides what appears without searching.
 */
const WNAT: Address = '0xC67DCE33D7A8efA5FfEB961899C73fe01bCe9273';

export const TOKENS: TokenConfig[] = [
  { symbol: 'FMINA', address: CONTRACTS.fmina, decimals: 9, note: 'Bridged MINA' },
  { symbol: 'C2FLR', address: WNAT, decimals: 18, native: true },
  { symbol: 'FXRP', address: '0x0b6A3645c240605887a5532109323A3E12273dc7', decimals: 6 },
  { symbol: 'USD₮0', address: '0xC1A5B41512496B80903D1f32d6dEa3a73212E71F', decimals: 6 },
  { symbol: 'WC2FLR', address: WNAT, decimals: 18 },
];

/**
 * What the Flare -> Mina direction can send.
 *
 * FMINA goes back through the escrow — it is bridged MINA, so the escrow
 * releases the original. Everything else is locked in the vault and minted as a
 * new token on Mina, which is the opposite direction of collateral and a
 * different contract.
 *
 * `minaDecimals` differs from `decimals` only for C2FLR: at 18, a `UInt64` caps
 * out at 18 whole tokens, so it crosses as the 9-decimal wrapper.
 */
export type BridgeAsset = {
  symbol: string;
  address: Address;
  decimals: number;
  minaDecimals: number;
  /** Which contract takes it, and therefore which rail it rides. */
  rail: 'escrow' | 'vault';
  /** The chain's own coin. Locked with `lockNative`, which wraps it for you. */
  native?: boolean;
  /** What it is called once it lands on Mina. */
  minaSymbol: string;
};

export const BRIDGE_ASSETS: BridgeAsset[] = [
  { symbol: 'FMINA', address: CONTRACTS.fmina, decimals: 9, minaDecimals: 9, rail: 'escrow', minaSymbol: 'MINA' },
  { symbol: 'C2FLR', address: WNAT, decimals: 18, minaDecimals: 9, rail: 'vault', native: true, minaSymbol: 'bC2FLR' },
  { symbol: 'FXRP', address: '0x0b6A3645c240605887a5532109323A3E12273dc7', decimals: 6, minaDecimals: 6, rail: 'vault', minaSymbol: 'bFXRP' },
  { symbol: 'USD₮0', address: '0xC1A5B41512496B80903D1f32d6dEa3a73212E71F', decimals: 6, minaDecimals: 6, rail: 'vault', minaSymbol: 'bUSDT' },
];

/**
 * What the Mina -> Flare direction can send.
 *
 * MINA is escrowed and minted as FMINA. The wrapped assets travel the opposite
 * way: they were minted here against something locked in the vault on Flare, so
 * sending one back means burning it and releasing the original. `live` says
 * which of those two legs the relayer currently drives — see the README.
 */
export type InboundAsset = {
  symbol: string;
  decimals: number;
  flareSymbol: string;
  /** Mina token zkApp. Absent for MINA, which is the chain's own coin. */
  token?: string;
  /**
   * Its token id, derived from that account. Precomputed because deriving one
   * needs o1js, and pulling the prover into the page to read a balance is a
   * megabyte of wasm for a number the node already knows.
   */
  tokenId?: string;
  live: boolean;
};

export const INBOUND_ASSETS: InboundAsset[] = [
  { symbol: 'MINA', decimals: 9, flareSymbol: 'FMINA', live: true },
  {
    symbol: 'bC2FLR',
    decimals: 9,
    flareSymbol: 'C2FLR',
    token: 'B62qiVguTBzDp5vaHyTatzaQ2zTyhfU22tTi3VQ9MKfcnbnePukdQHQ',
    tokenId: 'xKJdu2C8Ljij5GKfQYjSMzFKmf1PbrR8FHySEiiGFU6wvt3ZDb',
    live: false,
  },
  {
    symbol: 'bFXRP',
    decimals: 6,
    flareSymbol: 'FXRP',
    token: 'B62qnmNChAeU6SpLDdze7FvVjoT4LsWCcHntiqmFx1aBvrd52mP3XVN',
    tokenId: 'xPHC6du23rjWCeJVxeKZ8xzgqCCAy5tHCD7WgsLr3bX9aW3Xyw',
    live: false,
  },
  {
    symbol: 'bUSDT',
    decimals: 6,
    flareSymbol: 'USD₮0',
    token: 'B62qjhVgqAbso6g8wsLNosuUMTyySicoqtgEbGGPYqWJXDCdQEH6Bg3',
    tokenId: 'woBocoVw25c3CwTmC4eiYiTTmuwMiCN5Q6ZnqMn2jrfue2sDBT',
    live: false,
  },
];

/** Mina side. */
export const MINA = {
  network: 'devnet',
  explorer: 'https://minascan.io/devnet',
  /** Escrow account. Deposits are plain payments here, with the Flare recipient in the memo. */
  bridgeAccount: 'B62qpRkbjE5wH6nFmZnVUN7yrjfAhpJPP2qXxn6z7KQsL6RojmkaDr6',
  /** Read-only. Used for balances; the wallet has its own endpoint for sending. */
  graphql: 'https://api.minascan.io/node/devnet/v1/graphql',
} as const;

export const explorerTx = (hash: string) => `${COSTON2.explorer}/tx/${hash}`;
export const explorerAddress = (a: string) => `${COSTON2.explorer}/address/${a}`;
