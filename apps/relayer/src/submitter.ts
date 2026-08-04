import { createWalletClient, createPublicClient, http, parseAbi, type Hex } from 'viem';
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

export type ClaimRequest = {
  publicKey: { x: bigint; isOdd: boolean; y: bigint };
  signature: { field: bigint; scalar: bigint };
  recipient: `0x${string}`;
  amountNanomina: bigint;
  nonce: bigint;
  expiry: bigint;
  attestation: Hex;
};

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
