import { createPublicClient, http, parseAbi } from 'viem';
import { pool } from './db/index.js';

/**
 * A read-only view of the machinery, for the frontend's Network tab.
 *
 * Everything a bridge does that matters is invisible from a balance: which
 * validator set signed, how far each chain's cursor has moved, whether a burn is
 * waiting on the FDC or on a proof. This assembles that from the two chains and
 * the relayer's own table, so the answer to "is it stuck, and on what?" is one
 * request rather than three explorers.
 */

const RPC = process.env.COSTON2_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const BRIDGE = process.env.FLARE_BRIDGE_ADDRESS as `0x${string}` | undefined;
const VAULT = process.env.FLARE_ASSET_VAULT_ADDRESS as `0x${string}` | undefined;
const REGISTRY = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019' as const;

const MINA_GRAPHQL =
  process.env.MINA_DEVNET_GRAPHQL ?? 'https://api.minascan.io/node/devnet/v1/graphql';
const ESCROW = process.env.MINA_BRIDGE_ACCOUNT;

const COSTON2 = {
  id: 114,
  name: 'Coston2',
  nativeCurrency: { name: 'Coston2 Flare', symbol: 'C2FLR', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const client = createPublicClient({ chain: COSTON2, transport: http(RPC) });

/** FDC's protocol id in the Relay contract. Its roots are what an attestation proves against. */
const FDC_PROTOCOL_ID = 200;

let relayAddress: `0x${string}` | undefined;

async function relay(): Promise<`0x${string}`> {
  relayAddress ??= await client.readContract({
    address: REGISTRY,
    abi: parseAbi(['function getContractAddressByName(string) view returns (address)']),
    functionName: 'getContractAddressByName',
    args: ['Relay'],
  });
  return relayAddress;
}

/** Never let one dead endpoint blank the whole page. */
async function attempt<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch {
    return null;
  }
}

/**
 * The escrow's zkApp state, by field order in MinaPortBridge.ts:
 * 0 signingPolicyRoot, 1-2 withdrawalAttestor, 3 flareActionState,
 * 4 processedActionState, 5 requiredWeight.
 */
async function minaState() {
  if (ESCROW === undefined) return null;
  const res = await fetch(MINA_GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `{ account(publicKey: "${ESCROW}") { balance { total } zkappState } }`,
    }),
  });
  const body = (await res.json()) as {
    data?: { account?: { balance?: { total?: string }; zkappState?: string[] } };
  };
  const account = body.data?.account;
  if (account?.zkappState === undefined) return null;
  return {
    address: ESCROW,
    balance: account.balance?.total ?? null,
    signingPolicyRoot: account.zkappState[0],
    flareActionState: account.zkappState[3],
    processedActionState: account.zkappState[4],
    requiredWeight: account.zkappState[5],
  };
}

/**
 * The live signing policy: who Flare's validator set currently is, and how much
 * of it this relayer holds a recoverable key for. Below the threshold, no state
 * can be published — which is the single most useful thing to see when the
 * bridge looks stalled.
 */
async function policy() {
  const address = await relay();
  // The epoch comes from FlareSystemsManager rather than Relay: Relay only
  // answers about rounds it has been given, and "which set is live right now"
  // is the question this panel is asking.
  const systems = await client.readContract({
    address: REGISTRY,
    abi: parseAbi(['function getContractAddressByName(string) view returns (address)']),
    functionName: 'getContractAddressByName',
    args: ['FlareSystemsManager'],
  });

  const [rewardEpochId, blockNumber] = await Promise.all([
    client
      .readContract({
        address: systems,
        abi: parseAbi(['function getCurrentRewardEpochId() view returns (uint32)']),
        functionName: 'getCurrentRewardEpochId',
      })
      .catch(() => undefined),
    client.getBlockNumber(),
  ]);

  const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM validator_keys');

  return {
    relay: address,
    blockNumber: blockNumber.toString(),
    rewardEpochId: rewardEpochId === undefined ? null : Number(rewardEpochId),
    fdcProtocolId: FDC_PROTOCOL_ID,
    knownValidatorKeys: Number(rows[0]?.n ?? 0),
  };
}

async function flareState() {
  if (BRIDGE === undefined) return null;
  const [withdrawalActionState, escrowedNanomina, currentMinaActionState] = await Promise.all([
    client.readContract({
      address: BRIDGE,
      abi: parseAbi(['function withdrawalActionState() view returns (uint256)']),
      functionName: 'withdrawalActionState',
    }),
    client.readContract({
      address: BRIDGE,
      abi: parseAbi(['function escrowedNanomina() view returns (uint256)']),
      functionName: 'escrowedNanomina',
    }).catch(() => undefined),
    client.readContract({
      address: BRIDGE,
      abi: parseAbi(['function currentMinaActionState() view returns (bytes32)']),
      functionName: 'currentMinaActionState',
    }).catch(() => undefined),
  ]);

  return {
    bridge: BRIDGE,
    vault: VAULT ?? null,
    withdrawalActionState: withdrawalActionState.toString(),
    escrowedNanomina: escrowedNanomina?.toString() ?? null,
    currentMinaActionState: currentMinaActionState ?? null,
  };
}

export type ActivityRow = {
  kind: 'deposit' | 'withdrawal';
  status: string;
  amountNanomina: string;
  counterparty: string;
  flareTxHash: string | null;
  minaTxHash: string | null;
  at: string;
};

/**
 * The two rails interleaved, newest first. Global rather than per-account: this
 * tab is about whether the bridge is moving, not about one user's funds.
 */
async function activity(limit: number): Promise<ActivityRow[]> {
  const { rows } = await pool.query<ActivityRow>(
    `SELECT 'deposit' AS kind, status, amount_nanomina AS "amountNanomina",
            recipient AS counterparty, flare_tx_hash AS "flareTxHash",
            mina_tx_hash AS "minaTxHash", updated_at AS at
       FROM deposits
     UNION ALL
     SELECT 'withdrawal' AS kind, status, amount_nanomina AS "amountNanomina",
            recipient AS counterparty, flare_tx_hash AS "flareTxHash",
            mina_tx_hash AS "minaTxHash", updated_at AS at
       FROM withdrawals
     ORDER BY at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function networkSnapshot(limit = 25) {
  const [flare, mina, signingPolicy, rows] = await Promise.all([
    attempt(flareState),
    attempt(minaState),
    attempt(policy),
    attempt(() => activity(limit)),
  ]);

  return {
    flare,
    mina,
    policy: signingPolicy,
    activity: rows ?? [],
    // The head each side has agreed on. Equal means every burn Flare has
    // recorded is claimable on Mina; unequal means a publication is due.
    inSync:
      flare !== null && mina !== null
        ? flare.withdrawalActionState === mina.flareActionState
        : null,
  };
}
