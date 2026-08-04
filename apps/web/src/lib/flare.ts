import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { COSTON2, CONTRACTS, DEX, TOKENS, type TokenConfig } from './config';

/** Read-only client. Reading never needs a wallet, so the app works before connecting. */
export const publicClient = createPublicClient({
  chain: {
    id: COSTON2.id,
    name: COSTON2.name,
    nativeCurrency: { name: COSTON2.nativeSymbol, symbol: COSTON2.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [COSTON2.rpc] } },
    // Coston2 has the canonical Multicall3, at the same address as every other
    // chain that ships it. viem will not use it unless the chain declares it,
    // and `publicClient.multicall` fails outright rather than falling back to
    // one call per read -- which is how the balances panel came to say
    // 'does not support contract "multicall3"' on a chain that does.
    contracts: {
      multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
    },
  },
  transport: http(COSTON2.rpc),
});

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
]);

export const factoryAbi = parseAbi([
  'function accountOf(bytes32) view returns (address)',
  'function isDeployed(bytes32) view returns (bool)',
  'function deploy(bytes32) returns (address)',
]);

export const registryAbi = parseAbi([
  'function nextNonceFor(uint256 x, bool isOdd) view returns (uint64)',
]);

export const accountAbi = parseAbi([
  'function execute((uint256,bool,uint256) publicKey,(uint256,uint256) signature,uint64 nonce,uint64 expiry,address target,uint256 value,bytes data) returns (bytes)',
  'function executeBatch((uint256,bool,uint256) publicKey,(uint256,uint256) signature,uint64 nonce,uint64 expiry,(address,uint256,bytes)[] calls) returns (bytes[])',
]);

export const bridgeAbi = parseAbi([
  'function claimWithMinaSignature((uint256,bool,uint256) publicKey,(uint256,uint256) signature,address recipient,uint64 amountNanomina,uint64 nonce,uint64 expiry,bytes attestation)',
  'function burnToMina(uint256 amount, bytes32 minaRecipient) returns (uint256)',
  'function consumedIntents(bytes32) view returns (bool)',
  'function escrowAttestor() view returns (address)',
]);

export const routerAbi = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
]);

export type Balance = {
  token: TokenConfig;
  raw: bigint;
  formatted: string;
};

/** Read every default-list balance for an address in one multicall. */
export async function readBalances(owner: Address): Promise<Balance[]> {
  const results = await publicClient.multicall({
    contracts: TOKENS.map((t) => ({
      address: t.address,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [owner] as const,
    })),
    allowFailure: true,
  });

  return TOKENS.map((token, i) => {
    const r = results[i];
    const raw = r?.status === 'success' ? (r.result as bigint) : 0n;
    return { token, raw, formatted: formatUnits(raw, token.decimals) };
  });
}

export async function readNativeBalance(owner: Address): Promise<string> {
  const wei = await publicClient.getBalance({ address: owner });
  return formatUnits(wei, 18);
}

/** The Flare address a Mina key owns. Known before anything is deployed. */
export async function deriveAccount(minaKeyPacked: Hex): Promise<{
  address: Address;
  deployed: boolean;
}> {
  const [address, deployed] = await Promise.all([
    publicClient.readContract({
      address: CONTRACTS.accountFactory,
      abi: factoryAbi,
      functionName: 'accountOf',
      args: [minaKeyPacked],
    }),
    publicClient.readContract({
      address: CONTRACTS.accountFactory,
      abi: factoryAbi,
      functionName: 'isDeployed',
      args: [minaKeyPacked],
    }),
  ]);
  return { address: address as Address, deployed: deployed as boolean };
}

export async function nextNonce(x: bigint, isOdd: boolean): Promise<bigint> {
  const n = await publicClient.readContract({
    address: CONTRACTS.authRegistry,
    abi: registryAbi,
    functionName: 'nextNonceFor',
    args: [x, isOdd],
  });
  return BigInt(n as bigint);
}

/** Quote a swap through BlazeSwap. Returns null when the pair has no route. */
export async function quote(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<bigint | null> {
  if (amountIn === 0n) return 0n;
  try {
    const amounts = (await publicClient.readContract({
      address: DEX.router,
      abi: routerAbi,
      functionName: 'getAmountsOut',
      args: [amountIn, [tokenIn, tokenOut]],
    })) as bigint[];
    return amounts[amounts.length - 1] ?? null;
  } catch {
    // No pair, or no liquidity. Returning null lets the UI say so plainly
    // rather than showing a zero that looks like a real quote.
    return null;
  }
}

/**
 * Submit a transaction with whatever EVM wallet is available.
 *
 * The submitter is not trusted and gains nothing: every field of the action is
 * committed to by the Mina signature. This is only about who pays the gas.
 */
export async function submit(to: Address, data: Hex): Promise<Hex> {
  const eth = (globalThis as { ethereum?: unknown }).ethereum;
  if (!eth) throw new Error('no EVM wallet found to pay gas with');

  const wallet = createWalletClient({ transport: custom(eth as never) });
  const [account] = await wallet.requestAddresses();
  if (!account) throw new Error('no account available');

  return wallet.sendTransaction({
    account,
    to,
    data,
    chain: publicClient.chain,
  });
}
