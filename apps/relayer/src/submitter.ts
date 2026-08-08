import { createWalletClient, createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Submits claims to Flare on the depositor's behalf.
 *
 * # Why this is not a trust concession
 *
 * The depositor's Schnorr signature commits to the recipient, the amount, the
 * nonce and the expiry, and `MinaPortBridge` recomputes every one of them
 * before it mints. A submitter cannot redirect the mint, change its size,
 * replay it, or mint to itself. The only power it has is to decline — and
 * anyone else can submit the same signature, so declining achieves nothing
 * either.
 *
 * That property is what the whole design rests on, and it is what makes this
 * safe: paying the gas is a favour, not an authorisation.
 *
 * # Why it exists
 *
 * A Mina key can authorise but cannot pay. Without this, claiming needs an EVM
 * wallet, which contradicts the one thing the product claims — that a Mina user
 * needs no EVM key. GAP 5 in docs/threat-model.md.
 *
 * Unset `FLARE_SUBMITTER_PRIVATE_KEY` and the API refuses the route, leaving
 * the client to submit through its own wallet.
 */

const RPC = process.env.COSTON2_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const BRIDGE = process.env.FLARE_BRIDGE_ADDRESS as `0x${string}` | undefined;

const COSTON2 = {
  id: 114,
  name: 'Coston2',
  nativeCurrency: { name: 'Coston2 Flare', symbol: 'C2FLR', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const bridgeAbi = parseAbi([
  'function claimWithMinaSignature((uint256,bool,uint256) publicKey,(uint256,uint256) signature,address recipient,uint64 amountNanomina,uint64 nonce,uint64 expiry,bytes attestation)',
]);

const accountAbi = parseAbi([
  'function executeBatch((uint256,bool,uint256) publicKey,(uint256,uint256) signature,uint64 nonce,uint64 expiry,(address,uint256,bytes)[] calls) returns (bytes[])',
]);

const factoryAbi = parseAbi([
  'function deploy(bytes32 minaKey) returns (address)',
  'function isDeployed(bytes32 minaKey) view returns (bool)',
]);

export type ClaimRequest = {
  publicKey: { x: bigint; isOdd: boolean; y: bigint };
  signature: { field: bigint; scalar: bigint };
  recipient: `0x${string}`;
  amountNanomina: bigint;
  nonce: bigint;
  expiry: bigint;
  attestation: Hex;
};

/**
 * Deploy the `MinaAccount` for a Mina key.
 *
 * Takes no signature and needs none. The address is `CREATE2(minaKey)`, so
 * deploying is permissionless and idempotent-by-address: a stranger doing it
 * changes nothing about who controls the account, and the contract still only
 * moves funds on a Schnorr signature from that one key. All this call spends is
 * gas.
 *
 * Nothing requires it up front — an address holds ERC-20 balances with no code
 * at all, which is why the bridge could mint here before any of this existed.
 * Deployment is only needed to *spend*, so it is offered rather than forced.
 */
export async function deployAccount(minaKey: Hex): Promise<Hex> {
  const key = process.env.FLARE_SUBMITTER_PRIVATE_KEY;
  const factory = process.env.FLARE_ACCOUNT_FACTORY as `0x${string}` | undefined;
  if (!key || factory === undefined) throw new Error('no submitter configured');

  const account = privateKeyToAccount(key as Hex);
  const wallet = createWalletClient({ account, chain: COSTON2, transport: http(RPC) });
  const publicClient = createPublicClient({ chain: COSTON2, transport: http(RPC) });

  // Cheaper to ask than to send a transaction that reverts on redeployment.
  const already = await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'isDeployed',
    args: [minaKey],
  });
  if (already) throw new Error('account is already deployed');

  const hash = await wallet.writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'deploy',
    args: [minaKey],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`deployment reverted (${hash})`);
  return hash;
}

export type BatchRequest = {
  account: `0x${string}`;
  publicKey: { x: bigint; isOdd: boolean; y: bigint };
  signature: { field: bigint; scalar: bigint };
  nonce: bigint;
  expiry: bigint;
  calls: { target: `0x${string}`; value: bigint; data: Hex }[];
};

/**
 * Execute a signed batch on the user's `MinaAccount`, paying the gas.
 *
 * Same property as a claim, and the reason batching exists: the Schnorr
 * signature commits to the ordered list of calls through `batchHash`, and the
 * account recomputes it. A submitter cannot reorder the batch, drop a call,
 * add one, or change a target or its calldata. It can only decline.
 *
 * That is what makes an approve-then-swap safe to hand to someone else: the
 * batch is atomic, so a granted approval cannot survive a failed swap, and the
 * submitter cannot separate the two.
 */
export async function submitBatch(request: BatchRequest): Promise<Hex> {
  const key = process.env.FLARE_SUBMITTER_PRIVATE_KEY;
  if (!key) throw new Error('no submitter configured');

  const account = privateKeyToAccount(key as Hex);
  const wallet = createWalletClient({ account, chain: COSTON2, transport: http(RPC) });
  const publicClient = createPublicClient({ chain: COSTON2, transport: http(RPC) });

  const hash = await wallet.writeContract({
    address: request.account,
    abi: accountAbi,
    functionName: 'executeBatch',
    args: [
      [request.publicKey.x, request.publicKey.isOdd, request.publicKey.y],
      [request.signature.field, request.signature.scalar],
      request.nonce,
      request.expiry,
      request.calls.map((c) => [c.target, c.value, c.data] as const),
    ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`batch reverted on Flare (${hash})`);
  return hash;
}

export function submitterConfigured(): boolean {
  return (
    typeof process.env.FLARE_SUBMITTER_PRIVATE_KEY === 'string' &&
    process.env.FLARE_SUBMITTER_PRIVATE_KEY.length > 0 &&
    BRIDGE !== undefined
  );
}

/**
 * Send the claim and wait for it to be mined.
 *
 * Waiting rather than returning the hash immediately: a claim that reverts
 * should surface as an error the user can read, not as a hash they have to go
 * and check themselves. It costs a few seconds on a chain with sub-second
 * blocks.
 */
/** The return leg's claim: same bargain, different contract. */
export type ReleaseClaim = {
  publicKey: { x: bigint; isOdd: boolean; y: bigint };
  signature: { field: bigint; scalar: bigint };
  token: Address;
  recipient: Address;
  amount: bigint;
  nonce: bigint;
  expiry: bigint;
  attestation: Hex;
};

const vaultReleaseAbi = parseAbi([
  'function releaseWithMinaSignature((uint256,bool,uint256) publicKey, (uint256,uint256) signature, address token, address recipient, uint256 amount, uint64 nonce, uint64 expiry, bytes attestation)',
]);

/**
 * Pay the gas for a release the holder authorised.
 *
 * Gas in exchange for nothing, exactly like a deposit claim: the vault
 * recomputes the token, recipient, amount, nonce and expiry from the holder's
 * Schnorr signature, so this service cannot redirect or resize anything. It is
 * what lets a Mina user take their assets back without holding an EVM key.
 */
export async function submitRelease(claim: ReleaseClaim): Promise<Hex> {
  const key = process.env.FLARE_SUBMITTER_PRIVATE_KEY;
  const vault = process.env.FLARE_ASSET_VAULT_ADDRESS as Address | undefined;
  if (!key || vault === undefined) throw new Error('no submitter configured');

  const account = privateKeyToAccount(key as Hex);
  const wallet = createWalletClient({ account, chain: COSTON2, transport: http(RPC) });
  const publicClient = createPublicClient({ chain: COSTON2, transport: http(RPC) });

  const hash = await wallet.writeContract({
    address: vault,
    abi: vaultReleaseAbi,
    functionName: 'releaseWithMinaSignature',
    args: [
      [claim.publicKey.x, claim.publicKey.isOdd, claim.publicKey.y],
      [claim.signature.field, claim.signature.scalar],
      claim.token,
      claim.recipient,
      claim.amount,
      claim.nonce,
      claim.expiry,
      claim.attestation,
    ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`release reverted on Flare (${hash})`);
  return hash;
}

export async function submitClaim(claim: ClaimRequest): Promise<Hex> {
  const key = process.env.FLARE_SUBMITTER_PRIVATE_KEY;
  if (!key || BRIDGE === undefined) {
    throw new Error('no submitter configured');
  }

  const account = privateKeyToAccount(key as Hex);
  const wallet = createWalletClient({ account, chain: COSTON2, transport: http(RPC) });
  const publicClient = createPublicClient({ chain: COSTON2, transport: http(RPC) });

  const hash = await wallet.writeContract({
    address: BRIDGE,
    abi: bridgeAbi,
    functionName: 'claimWithMinaSignature',
    args: [
      [claim.publicKey.x, claim.publicKey.isOdd, claim.publicKey.y],
      [claim.signature.field, claim.signature.scalar],
      claim.recipient,
      claim.amountNanomina,
      claim.nonce,
      claim.expiry,
      claim.attestation,
    ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`claim reverted on Flare (${hash})`);
  }
  return hash;
}
