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
  // The router wraps and unwraps around the swap, so a native trade needs no
  // separate deposit or withdraw call — and leaves no wrapped dust behind when
  // slippage means the output is not exactly what was quoted.
  'function swapExactNATForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
  'function swapExactTokensForNAT(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
]);

export type Balance = {
  token: TokenConfig;
  raw: bigint;
  formatted: string;
};

/**
 * Read every default-list balance for an address in one multicall.
 *
 * The native coin is not an ERC-20, so it is read separately and merged back in
 * at its place in the list.
 */
export async function readBalances(owner: Address): Promise<Balance[]> {
  const erc20s = TOKENS.filter((t) => t.native !== true);

  const [results, nativeWei] = await Promise.all([
    publicClient.multicall({
      contracts: erc20s.map((t) => ({
        address: t.address,
        abi: erc20Abi,
        functionName: 'balanceOf' as const,
        args: [owner] as const,
      })),
      allowFailure: true,
    }),
    publicClient.getBalance({ address: owner }),
  ]);

  return TOKENS.map((token) => {
    if (token.native === true) {
      return { token, raw: nativeWei, formatted: formatUnits(nativeWei, token.decimals) };
    }
    const r = results[erc20s.indexOf(token)];
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

export type Route = {
  /** Token addresses the swap hops through, input first, output last. */
  path: Address[];
  amountOut: bigint;
};

/**
 * The tokens a two-hop route may pass through.
 *
 * Every listed token, in practice: the set is small enough that filtering it
 * would only risk missing the pair that happens to hold the liquidity. FMINA,
 * for instance, has pools against WC2FLR and USD₮0 and against nothing else, so
 * every other destination needs a hop.
 */
const HOPS: Address[] = [...new Set(TOKENS.map((t) => t.address.toLowerCase()))] as Address[];

/**
 * Best route for a swap, direct or through one intermediate token.
 *
 * Candidates are quoted in a single multicall rather than one call each: the
 * router prices them independently, so asking sequentially would multiply the
 * latency by the number of candidates for no better answer.
 *
 * Two hops is the limit on purpose. Three would roughly square the candidate
 * count for a gain that this many tokens cannot produce, and every extra hop is
 * another pool taking a fee and another chance to move against the trade.
 */
export async function bestRoute(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<Route | null> {
  if (amountIn === 0n) return { path: [tokenIn, tokenOut], amountOut: 0n };
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;

  const candidates: Address[][] = [[tokenIn, tokenOut]];
  for (const mid of HOPS) {
    const m = mid.toLowerCase();
    if (m === tokenIn.toLowerCase() || m === tokenOut.toLowerCase()) continue;
    candidates.push([tokenIn, mid, tokenOut]);
  }

  const results = await publicClient.multicall({
    contracts: candidates.map((path) => ({
      address: DEX.router,
      abi: routerAbi,
      functionName: 'getAmountsOut' as const,
      args: [amountIn, path] as const,
    })),
    // A missing pair reverts, which is an answer rather than a failure.
    allowFailure: true,
  });

  let best: Route | null = null;
  results.forEach((r, i) => {
    if (r.status !== 'success') return;
    const amounts = r.result as readonly bigint[];
    const amountOut = amounts[amounts.length - 1];
    if (amountOut === undefined || amountOut === 0n) return;
    if (best === null || amountOut > best.amountOut) {
      best = { path: candidates[i]!, amountOut };
    }
  });

  return best;
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
