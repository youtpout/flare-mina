import { createPublicClient, http, parseAbi, parseEventLogs } from 'viem';
import { decodeMinaRecipient, formatMinaAddress } from '@minaport/shared';
import {
  markLockMinted,
  markLockMinting,
  markLocksPublished,
  mintableLocks,
  recordLock,
  transferIndexOf,
  transferRange,
} from './db/index.js';
import { mintLock } from './prover/index.js';

/**
 * The Flare -> Mina asset rail: FXRP, USD₮0 and C2FLR.
 *
 * Every asset shares one chain with the MINA rail, so publishing its head is
 * not this file's job — transfers.ts does it once for all four. What is left is
 * per-asset:
 *
 *   watch    read `AssetLocked` from the vault, for status    cheap
 *   mint     replay the range and mint, two Mina transactions  expensive
 *
 * Nothing here can create supply. A mint has to be the next link in the chain
 * ending at a head the Flare validator set signed, and the port checks that
 * itself — this process only decides *when*.
 */

const RPC = process.env.COSTON2_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const VAULT = process.env.FLARE_ASSET_VAULT_ADDRESS as `0x${string}` | undefined;

const WATCH_MS = Number(process.env.LOCK_INTERVAL_MS ?? 20_000);

const LOOKBACK = BigInt(process.env.LOCK_LOOKBACK_BLOCKS ?? 3_000);
/** The public RPC rejects wider `getLogs` windows. */
const CHUNK = BigInt(process.env.LOCK_CHUNK_BLOCKS ?? 30);

const COSTON2 = {
  id: 114,
  name: 'Coston2',
  nativeCurrency: { name: 'Coston2 Flare', symbol: 'C2FLR', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const client = createPublicClient({ chain: COSTON2, transport: http(RPC) });

const vaultAbi = parseAbi([
  'event AssetLocked(uint256 indexed claimId, address indexed token, address indexed sender, bytes32 minaRecipient, uint256 amount, uint256 previousActionState, uint256 newActionState)',
  'function lockActionStateOf(address) view returns (uint256)',
]);

/**
 * One bridged asset. Configured rather than discovered: a port is deployed by
 * hand and pairs one Flare token with one Mina token, so a wrong pairing would
 * mint the wrong asset and no amount of scanning could detect it.
 */
export type Asset = {
  symbol: string;
  /** Flare token address. Also the key of its lock chain in the vault. */
  flareToken: `0x${string}`;
  /** AssetPort zkApp, base58. */
  port: string;
  /** FungibleToken zkApp, base58. */
  token: string;
  /**
   * Its token id. A balance lives in its own account keyed by this, so reading
   * one without it returns the holder's MINA instead — silently, as zero.
   */
  tokenId?: string;
  decimals: number;
};

/**
 * Read from `MINA_ASSET_PORTS`, a JSON array of {Asset}. Absent means the asset
 * rail is off, which is a supported deployment — the MINA rail does not need it.
 */
export function assets(): Asset[] {
  const raw = process.env.MINA_ASSET_PORTS;
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Asset[];
  } catch (e) {
    console.error('MINA_ASSET_PORTS is not valid JSON:', e instanceof Error ? e.message : e);
    return [];
  }
}

const MINA_GRAPHQL =
  process.env.MINA_DEVNET_GRAPHQL ?? 'https://api.minascan.io/node/devnet/v1/graphql';

/**
 * A port's accepted head and cursor, read from Mina.
 *
 * `zkappState` by field order in AssetPort.ts: 0 signingPolicyRoot,
 * 1 flareLockState, 2 processedLockState.
 */
async function portState(port: string): Promise<{ accepted: bigint; processed: bigint } | null> {
  try {
    const res = await fetch(MINA_GRAPHQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `{ account(publicKey: "${port}") { zkappState } }` }),
    });
    const body = (await res.json()) as { data?: { account?: { zkappState?: string[] } } };
    const state = body.data?.account?.zkappState;
    if (state === undefined) return null;
    return { accepted: BigInt(state[1]!), processed: BigInt(state[2]!) };
  } catch {
    return null;
  }
}

/**
 * Mint everything a port has accepted a head for, oldest claim first.
 *
 * The range comes from the shared ledger, not from this table: a segment has to
 * replay the other assets' transfers too, since stepping over them is what lets
 * one chain serve four ports. Which lock gets minted is the circuit's decision.
 */
async function mint(): Promise<void> {
  for (const asset of assets()) {
    const state = await portState(asset.port);
    if (state === null) continue;

    const covered = await markLocksPublished(asset.flareToken, state.accepted);
    if (covered > 0) console.log(`${covered} ${asset.symbol} lock(s) now mintable`);

    const queue = await mintableLocks(asset.flareToken);
    if (queue.length === 0) continue;

    // One at a time: the port advances a cursor, so two mints in one block
    // conflict.
    for (const row of queue) {
      // Re-read: the previous mint moved the cursor, and a range starting where
      // the port no longer is would be refused.
      const now = await portState(asset.port);
      if (now === null) break;

      const range = await transferRange(now.processed, now.accepted);
      if (range === null) {
        console.warn(`${asset.symbol}: the transfer ledger has not caught up`);
        break;
      }
      if (range.length === 0) break;

      // A row can outlive the mint that settled it: the transaction lands, and
      // the process dies before recording it — which a restart does routinely.
      // The port's cursor is the truth, so a claim it has already moved past is
      // minted, and retrying it forever only hides real failures.
      const cursorIndex = await transferIndexOf(now.processed);
      if (cursorIndex !== null && BigInt(row.claim_id) <= cursorIndex) {
        await markLockMinted(row.id, row.mina_tx_hash ?? 'recovered');
        console.log(`${asset.symbol} claim ${row.claim_id} was already minted; catching the row up`);
        continue;
      }

      try {
        await markLockMinting(row.id);
        const hash = await mintLock({
          port: asset.port,
          token: asset.token,
          asset: asset.flareToken,
          range: range.map((r) => ({
            index: BigInt(r.chain_index),
            token: r.token,
            recipient: r.recipient,
            amount: BigInt(r.amount),
          })),
        });
        await markLockMinted(row.id, hash);
        console.log(`minted ${asset.symbol} claim ${row.claim_id} -> ${row.recipient}`);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        // Left in 'minting' rather than marked failed, and 'minting' is still
        // picked up by `mintableLocks`: the usual cause is the previous mint
        // not yet included, which resolves on its own. Marking it failed would
        // strand the user's tokens in the vault with nothing retrying.
        console.warn(`${asset.symbol} claim ${row.claim_id} not minted: ${reason}`);
        return;
      }
    }
  }
}

function loop(name: string, every: number, tick: () => Promise<void>): { stop(): void } {
  let stopped = false;

  const run = async () => {
    while (!stopped) {
      try {
        await tick();
      } catch (e) {
        console.error(`${name} tick failed:`, e instanceof Error ? e.message : e);
      }
      await new Promise((r) => setTimeout(r, every));
    }
  };

  void run();
  return { stop: () => (stopped = true) };
}

export function startAssets(): { stop(): void } {
  if (VAULT === undefined || assets().length === 0) {
    return { stop: () => undefined };
  }

  // Publishing lives in transfers.ts: one attestation covers every asset now,
  // so a per-asset publisher would pay for the same round four times.
  // Watching lives in transfers.ts: one scan of the shared chain fills both
  // rails' tables, where three scanners only bought rate-limit errors.
  const loops = [loop('minter', WATCH_MS, mint)];
  return { stop: () => loops.forEach((l) => l.stop()) };
}
