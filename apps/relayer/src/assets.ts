import { createPublicClient, http, parseAbi, parseEventLogs } from 'viem';
import { decodeMinaRecipient, formatMinaAddress } from '@minaport/shared';
import {
  lockTxFor,
  markLockMinted,
  markLockMinting,
  markLocksPublished,
  mintableLocks,
  recordLock,
} from './db/index.js';
import { mintLock, publishLockState } from './prover/index.js';
import { fetchAttestation, requestAttestationFor, type Attestation } from './fdc.js';
import { policyProofInputs } from './publisher.js';

/**
 * The Flare -> Mina asset rail: FXRP, USD₮0 and C2FLR.
 *
 * Structurally identical to the withdrawal rail, one chain per token instead of
 * one for the whole bridge. Three stages, each on its own timer because they
 * cost very different things:
 *
 *   watch    read `AssetLocked` from the vault                cheap
 *   publish  carry the chain head to the port, with ECDSA     expensive
 *   mint     replay the tail and mint, two Mina transactions  expensive
 *
 * Nothing here can create supply. A mint has to be the next link in the chain
 * ending at a head the Flare validator set signed, and the port checks that
 * itself — this process only decides *when*.
 */

const RPC = process.env.COSTON2_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const VAULT = process.env.FLARE_ASSET_VAULT_ADDRESS as `0x${string}` | undefined;

/** Same cadence as the withdrawal publisher, and for the same reason. */
const PUBLISH_MS = Number(process.env.PUBLISH_INTERVAL_MS ?? 15 * 60_000);
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
 * Where the last scan reached, so a tick costs one window rather than the whole
 * lookback. The public RPC caps `getLogs` at 30 blocks, so 3000 blocks is 100
 * requests — every 20 seconds that is rate-limited within a minute, which is
 * exactly how this first failed.
 */
let scannedTo: bigint | undefined;

/** Scan for `AssetLocked` and record what has not been seen. */
async function watch(): Promise<void> {
  if (VAULT === undefined) return;

  const head = await client.getBlockNumber();
  // Re-scan a little behind the watermark: recording is idempotent, and a
  // reorg or a missed block costs a mint nobody can retry by hand.
  const from =
    scannedTo === undefined
      ? head > LOOKBACK
        ? head - LOOKBACK
        : 0n
      : scannedTo > CHUNK
        ? scannedTo - CHUNK
        : 0n;

  for (let start = from; start <= head; start += CHUNK) {
    const end = start + CHUNK - 1n > head ? head : start + CHUNK - 1n;
    const logs = await client.getLogs({ address: VAULT, fromBlock: start, toBlock: end });

    for (const log of parseEventLogs({ abi: vaultAbi, logs, eventName: 'AssetLocked' })) {
      const { claimId, token, minaRecipient, amount, newActionState } = log.args;
      await recordLock({
        token,
        claimId,
        recipient: formatMinaAddress(decodeMinaRecipient(minaRecipient)),
        amount,
        flareTxHash: log.transactionHash,
        newLockState: newActionState,
      });
    }
    scannedTo = end;
  }
}

/**
 * Heads already sent and awaiting inclusion, per port.
 *
 * Devnet takes minutes, and the port still shows the old head for all of them.
 * Without this the next tick publishes the same head again, and the two fight
 * over the fee payer's nonce.
 */
const publishInFlight = new Map<string, { state: bigint; at: number }>();

/** Long enough for devnet inclusion, short enough that a rejection is retried. */
const IN_FLIGHT_TTL_MS = Number(process.env.PUBLISH_IN_FLIGHT_TTL_MS ?? 12 * 60_000);

/** `AssetLocked(uint256,address,address,bytes32,uint256,uint256,uint256)`. */
const LOCK_TOPIC0 =
  '0x078ee1eead8e83dabf8464df5a5e308db068b136607c9f7bef8e86f6fc783add' as const;

/**
 * Get the round carrying a lock event, waiting for it to finalise.
 *
 * Polls inside the tick rather than deferring to the next one: the FDC settles
 * about a minute after a round closes, and the next tick is ten minutes away.
 */
async function attestationFor(txHash: `0x${string}`): Promise<Attestation | null> {
  if (VAULT === undefined) return null;
  const expected = { emitter: VAULT, topic0: LOCK_TOPIC0 };

  const { request, round } = await requestAttestationFor(txHash, expected);
  console.log(`requested attestation for ${txHash} in round ${round}`);

  const deadline = Date.now() + Number(process.env.FDC_WAIT_MS ?? 5 * 60_000);
  while (Date.now() < deadline) {
    const attestation = await fetchAttestation(request, round, expected);
    if (attestation !== null) return attestation;
    await new Promise((r) => setTimeout(r, 20_000));
  }
  console.warn(`round ${round} did not finalise in time; will retry next tick`);
  return null;
}

/** Carry each token's chain head to its port, when the port is behind. */
async function publish(): Promise<void> {
  if (VAULT === undefined) return;
  const list = assets();
  if (list.length === 0) return;

  // Not shared between assets any more: each attestation lands in its own FDC
  // round, and the signatures have to be for that round or the inclusion path
  // reaches a root nobody signed.

  for (const asset of list) {
    const onFlare = await client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'lockActionStateOf',
      args: [asset.flareToken],
    });
    if (onFlare === 0n) continue;

    const state = await portState(asset.port);
    if (state === null || state.accepted === onFlare) continue;
    const sent = publishInFlight.get(asset.port);
    if (sent?.state === onFlare && Date.now() - sent.at < IN_FLIGHT_TTL_MS) continue;

    const txHash = (await lockTxFor(asset.flareToken, onFlare)) as `0x${string}` | null;
    if (txHash === null) {
      console.warn(`no recorded ${asset.symbol} lock produced state ${onFlare}`);
      continue;
    }

    const attestation = await attestationFor(txHash);
    if (attestation === null) continue;
    if (attestation.event.newActionState !== onFlare) {
      console.warn(`the attested ${asset.symbol} event carries a different state`);
      continue;
    }

    const inputs = await policyProofInputs(attestation.round);
    if (inputs === null) continue;

    publishInFlight.set(asset.port, { state: onFlare, at: Date.now() });
    try {
      const hash = await publishLockState({
        port: asset.port,
        response: attestation.response.slice(2),
        siblings: attestation.proof.map((p) => p.slice(2)),
        calls: inputs.calls,
        keys: inputs.keys,
      });
      console.log(`published ${asset.symbol} lock head ${onFlare} -> ${hash}`);
    } catch (e) {
      // Retry on the next tick: leaving it marked would strand the asset.
      publishInFlight.delete(asset.port);
      throw e;
    }
  }
}

/** Mint everything a port has accepted a head for, oldest claim first. */
async function mint(): Promise<void> {
  for (const asset of assets()) {
    const state = await portState(asset.port);
    if (state === null) continue;

    const covered = await markLocksPublished(asset.flareToken, state.accepted);
    if (covered > 0) console.log(`${covered} ${asset.symbol} lock(s) now mintable`);

    const queue = await mintableLocks(asset.flareToken);
    if (queue.length === 0) continue;

    // Oldest first, and one at a time: the port advances a cursor, so two mints
    // in one block conflict. The tail is everything after this claim in the
    // batch — the port needs a continuation reaching the accepted head.
    for (let i = 0; i < queue.length; i++) {
      const row = queue[i]!;
      try {
        await markLockMinting(row.id);
        const hash = await mintLock({
          port: asset.port,
          token: asset.token,
          claimId: BigInt(row.claim_id),
          recipient: row.recipient,
          amount: BigInt(row.amount),
          tail: queue.slice(i + 1).map((r) => ({
            claimId: BigInt(r.claim_id),
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

  const loops = [
    loop('lock watcher', WATCH_MS, watch),
    loop('lock publisher', PUBLISH_MS, publish),
    // After the publisher: a mint cannot land ahead of the head it proves against.
    loop('minter', WATCH_MS, mint),
  ];
  return { stop: () => loops.forEach((l) => l.stop()) };
}
