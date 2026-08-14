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

/**
 * Every contract this environment owns, per network.
 *
 * All of them, not just the auth pair: a deposit signature commits to the
 * bridge address as its `target`, so signing against devnet's bridge and
 * claiming on Mesa's fails with `InvalidMinaSignature` — correctly, and
 * opaquely. Anything the user signs over must come from here.
 *
 * The third-party tokens below are Coston2's own and are the same on both.
 */
const OWN = {
  devnet: {
    authRegistry: '0xcf12aCe3f7D13EE714D57ee22EfA14cbb662fc56',
    accountFactory: '0x2a2AcdD54B93675828028fb8108fACc0A387fe23',
    bridge: '0x871493412EDCcfE0d24f127E6Deb2B20AE5497aB',
    fmina: '0x4aFce36d468136eD9d880E28C99373F0C3d3f046',
    assetVault: '0xa179E908C3F1156Edda0BD5f1A0B3b3f419f9F90',
    wrapperFactory: '0x98f0CA385dBe0724b4D9211fA4e515eB4d6848b7',
  },
  mesa: {
    authRegistry: '0x7481da09d9BC643D6da75185B2b023f22A8a10bE',
    accountFactory: '0x427e51eE63be082c5Ee813ae5ADbB94D79Ff8A0D',
    bridge: '0x06E584e72b36494Bb84A2C1df34E665Cf7673517',
    fmina: '0x05b5e8505e35505233955080f02b7351747B1C7f',
    assetVault: '0x669BDaa9B9802Ca92A4Ed5a29933805B09E33EeC',
    wrapperFactory: '0x45d401A560853b71C6546124F0AA8553cE59Fe38',
  },
} as const;

export const CONTRACTS = {
  /**
   * Third-party Coston2 contracts first, so nothing below can shadow the
   * per-network spread. An earlier version had the spread first and a stale
   * `bridge:` literal after it — which silently won, and the wallet went on
   * signing for the wrong bridge through three rounds of cache-clearing.
   *
   * C2FLR rounded from 18 decimals to 9, because a `UInt64` on Mina caps at
   * ~18.4 whole tokens otherwise. `wnat` is its ERC-20 form; `withdraw` turns
   * it back into the coin.
   */
  wrappedC2flr: '0x6C790956D728ed82A75d2ec8D5c37F2e2F36b978',
  wnat: '0xC67DCE33D7A8efA5FfEB961899C73fe01bCe9273',

  // Ours, and therefore per network. Last, so it always wins.
  ...OWN[import.meta.env.VITE_MINA_NETWORK === 'mesa' ? 'mesa' : 'devnet'],
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
  // The 9-decimal form C2FLR crosses as. Listed so a holder can see one they
  // were handed before the vault unwrapped on the way back, and undo it.
  {
    symbol: 'bWC2FLR',
    address: CONTRACTS.wrappedC2flr,
    decimals: 9,
    note: 'C2FLR at bridge decimals',
  },
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
  /** The Flare asset it is backed by, and the one a burn releases. */
  flareToken?: `0x${string}`;
  /**
   * Its token id, derived from that account. Precomputed because deriving one
   * needs o1js, and pulling the prover into the page to read a balance is a
   * megabyte of wasm for a number the node already knows.
   */
  tokenId?: string;
  live: boolean;
};

/**
 * Mesa carries its own zkApps and therefore its own token ids: a token id is
 * derived from the token account, and the accounts are redeployed per network.
 * Reading a balance with the wrong one returns the holder's MINA, as zero.
 */
const MESA_INBOUND: Record<string, { token: string; tokenId: string }> = {
  bFXRP: {
    token: 'B62qmjL7PuoW8yxM4y51HarCQRH3mAzCtBXocFrAVYdeH1eHmFHjpng',
    tokenId: 'wpnE6S86LdbaLEw1vaW1t3adsTZSmqtfhh9yWyrxXYGyYTFjSu',
  },
  bUSDT: {
    token: 'B62qoQ3iGmVhfw5ebEErHXbXHLybU5XvJuBLHAENT2V781G73JvNqDR',
    tokenId: 'y4ArcY7GAzD4yejMQWXxf7MeqtFKfSzuYzRJYT4V55vTZwwuR9',
  },
  bC2FLR: {
    token: 'B62qjBSNZv2FEP1Ey6VokZga2H4Do96VYuEuBXFLJvrQhfs73BtvbhJ',
    tokenId: 'xRKh3ZoGhKvshUpYhAM5oHFh3GCmoGKxnrgEqgxkx9Uo9SsGia',
  },
};

const DEVNET_INBOUND: InboundAsset[] = [
  { symbol: 'MINA', decimals: 9, flareSymbol: 'FMINA', live: true },
  {
    symbol: 'bC2FLR',
    decimals: 9,
    flareSymbol: 'C2FLR',
    token: 'B62qiVguTBzDp5vaHyTatzaQ2zTyhfU22tTi3VQ9MKfcnbnePukdQHQ',
    tokenId: 'xKJdu2C8Ljij5GKfQYjSMzFKmf1PbrR8FHySEiiGFU6wvt3ZDb',
    flareToken: '0x6C790956D728ed82A75d2ec8D5c37F2e2F36b978',
    live: true,
  },
  {
    symbol: 'bFXRP',
    decimals: 6,
    flareSymbol: 'FXRP',
    token: 'B62qnmNChAeU6SpLDdze7FvVjoT4LsWCcHntiqmFx1aBvrd52mP3XVN',
    tokenId: 'xPHC6du23rjWCeJVxeKZ8xzgqCCAy5tHCD7WgsLr3bX9aW3Xyw',
    flareToken: '0x0b6A3645c240605887a5532109323A3E12273dc7',
    live: true,
  },
  {
    symbol: 'bUSDT',
    decimals: 6,
    flareSymbol: 'USD₮0',
    token: 'B62qjhVgqAbso6g8wsLNosuUMTyySicoqtgEbGGPYqWJXDCdQEH6Bg3',
    tokenId: 'woBocoVw25c3CwTmC4eiYiTTmuwMiCN5Q6ZnqMn2jrfue2sDBT',
    flareToken: '0xC1A5B41512496B80903D1f32d6dEa3a73212E71F',
    live: true,
  },
];

/**
 * Mina side.
 *
 * `VITE_MINA_NETWORK=mesa` switches the endpoint and the escrow, so a Mesa
 * build needs no code change — but note the addresses differ: zkApps do not
 * exist across networks, they are redeployed, so `VITE_MINA_BRIDGE_ACCOUNT`
 * must be set for Mesa or the app reads an account that is not there.
 *
 * `MinaLink` still guards on `explorer` being set: a future network may land
 * before its explorer does, and an empty base builds a relative link onto the
 * app's own 404.
 */
const MINA_NETWORKS = {
  devnet: {
    network: 'devnet',
    explorer: 'https://minascan.io/devnet',
    bridgeAccount: 'B62qpRkbjE5wH6nFmZnVUN7yrjfAhpJPP2qXxn6z7KQsL6RojmkaDr6',
    /**
     * Read-only. Used for balances; the wallet has its own endpoint for sending.
     *
     * Not minascan's node, which answers most token accounts in ~200ms and then
     * times out on others every single time — measured 2/2 on bC2FLR while this
     * one answered in under 180ms on every attempt.
     */
    graphql: 'https://mina-devnet-graphql.aurowallet.com/graphql',
  },
  mesa: {
    network: 'mesa',
    explorer: 'https://minascan.io/mesa',
    bridgeAccount: import.meta.env.VITE_MINA_BRIDGE_ACCOUNT ?? '',
    graphql: 'https://mesa.minataur.net/graphql',
  },
} as const;

const MINA_NETWORK =
  import.meta.env.VITE_MINA_NETWORK === 'mesa' ? 'mesa' : 'devnet';

export const MINA = MINA_NETWORKS[MINA_NETWORK];

/**
 * Mesa redeploys its zkApps, so it carries its own token accounts and token
 * ids. Everything else about an asset — decimals, its Flare counterpart — is
 * the same on both networks.
 */
export const INBOUND_ASSETS: InboundAsset[] =
  MINA_NETWORK === 'mesa'
    ? DEVNET_INBOUND.map((a) => ({ ...a, ...(MESA_INBOUND[a.symbol] ?? {}) }))
    : DEVNET_INBOUND;


/** Mesa has no explorer, so a link there would 404. */
export const minaAccountUrl = (address: string): string | null =>
  MINA.explorer ? `${MINA.explorer}/account/${address}` : null;

/**
 * A Mina GraphQL read that cannot hang the page.
 *
 * The public nodes answer in about 100ms in the ordinary case and then stall —
 * one measured read took 61 seconds. Without a deadline the card sits on "…"
 * for that whole time and the user reasonably concludes the app is broken. A
 * timeout turns it into a retry on the next poll instead.
 */
export async function minaQuery<T>(query: string, timeoutMs = 6000): Promise<T | null> {
  try {
    const res = await fetch(MINA.graphql, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { data?: T };
    return body.data ?? null;
  } catch {
    return null;
  }
}

export const explorerTx = (hash: string) => `${COSTON2.explorer}/tx/${hash}`;
export const explorerAddress = (a: string) => `${COSTON2.explorer}/address/${a}`;
