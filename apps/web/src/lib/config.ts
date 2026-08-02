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
  bridge: '0xdb78DA6dd5eC73b7089799eE85Fc2E43126CBae2',
  fmina: '0x68189e3a6F0Ef2D1accFd62b6De9abF791B3722e',
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
};

/**
 * Tokens shown by default.
 *
 * Swapping is not limited to these — the account executes any call, so any pair
 * on any DEX works. This list only decides what appears without searching.
 */
export const TOKENS: TokenConfig[] = [
  { symbol: 'FMINA', address: CONTRACTS.fmina, decimals: 9, note: 'Bridged MINA' },
  { symbol: 'FXRP', address: '0x0b6A3645c240605887a5532109323A3E12273dc7', decimals: 6 },
  { symbol: 'USD₮0', address: '0xC1A5B41512496B80903D1f32d6dEa3a73212E71F', decimals: 6 },
  {
    symbol: 'WC2FLR',
    address: '0xC67DCE33D7A8efA5FfEB961899C73fe01bCe9273',
    decimals: 18,
    note: 'Needs a 9-decimal wrapper to reach Mina',
  },
];

/** Mina side. */
export const MINA = {
  network: 'devnet',
  explorer: 'https://minascan.io/devnet',
  /** Escrow account. Deposits are plain payments here, with the Flare recipient in the memo. */
  bridgeAccount: 'B62qjzS4P9wxqnYjx5ey3Jpm9po9SqkUgCwz3QfwGPQ6iXwUVMZ7nc3',
} as const;

export const explorerTx = (hash: string) => `${COSTON2.explorer}/tx/${hash}`;
export const explorerAddress = (a: string) => `${COSTON2.explorer}/address/${a}`;
