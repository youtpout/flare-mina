import { createPublicClient, http, parseAbi, parseEventLogs } from 'viem';
import { decodeMinaRecipient, formatMinaAddress } from '@minaport/shared';
import { recordLock, recordTransfer, recordWithdrawal, transferTxFor } from './db/index.js';
import { publishActionState, publishLockState } from './prover/index.js';
import { fetchAttestation, requestAttestationFor, type Attestation } from './fdc.js';
import { policyProofInputs } from './publisher.js';
import { assets } from './assets.js';

/**
 * The shared Flare -> Mina chain: indexed here, published from here.
 *
 * Every asset folds into one `TransferChain`, so a cycle costs one attestation
 * request, one round to wait for, and one signing-policy proof — then the same
 * attestation is pushed into the escrow and every asset port. Per-asset chains
 * cost all of that per asset that moved, which does not keep up.
 *
 * Two jobs, on two cadences:
 *   - `watch`, every 20s: fill the ordered ledger the prover reads
 *   - `publish`, every 15min: carry the head to Mina, when anyone is behind
 */

const RPC = process.env.COSTON2_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const CHAIN = process.env.FLARE_TRANSFER_CHAIN_ADDRESS as `0x${string}` | undefined;

const WATCH_MS = Number(process.env.TRANSFER_INTERVAL_MS ?? 20_000);
/**
 * A cycle is not cheap: an attestation request, a round to finalise, then 1344
 * bytes hashed and a Merkle path climbed in-circuit. One publication covers
 * every transfer since the last, so a shorter cadence buys latency for one user
 * and pays for it in work the whole bridge shares. Nothing is sent when the
 * chain has not moved, so a quiet bridge costs nothing.
 */
const PUBLISH_MS = Number(process.env.PUBLISH_INTERVAL_MS ?? 15 * 60_000);

const LOOKBACK = BigInt(process.env.TRANSFER_LOOKBACK_BLOCKS ?? 3_000);
/** The public RPC rejects wider `getLogs` windows — it caps them at 30. */
const CHUNK = BigInt(process.env.TRANSFER_CHUNK_BLOCKS ?? 30);

const COSTON2 = {
  id: 114,
  name: 'Coston2',
  nativeCurrency: { name: 'Coston2 Flare', symbol: 'C2FLR', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const client = createPublicClient({ chain: COSTON2, transport: http(RPC) });

const chainAbi = parseAbi([
  // Must match the contract exactly: `parseEventLogs` filters on topic0, which
  // is the keccak of this signature, so a wrong field makes every transfer
  // invisible rather than mis-decoded — silence, not an error.
  'event Transfer(uint256 indexed index, address indexed token, address indexed sender, bytes32 minaRecipient, uint256 amount, uint256 previousHead, uint256 newHead)',
  'function head() view returns (uint256)',
]);

/** `Transfer(uint256,address,address,bytes32,uint256,uint256,uint256)`. */
const TRANSFER_TOPIC0 =
  '0x4f7b66d0ae11d82ea99fc8240e659baae1aa3b6b8a9710a907e81a0cfb3c533f' as const;

const FMINA = process.env.FLARE_FMINA_ADDRESS?.toLowerCase();

const MINA_GRAPHQL =
  process.env.MINA_DEVNET_GRAPHQL ?? 'https://api.minascan.io/node/devnet/v1/graphql';
const ESCROW = process.env.MINA_BRIDGE_ACCOUNT;

/** Last block scanned, so a restart does not re-read the whole chain. */
let scannedTo: bigint | undefined;

/**
 * Fill the ledger, and the per-rail table that renders it.
 *
 * One scan, not three. The `Transfer` event carries the index, the asset, the
 * recipient and the amount — everything `withdrawals` and `locks` hold — so
 * scanning the bridges' own events as well bought nothing and cost three times
 * the `getLogs` calls, which the public RPC answers with 429.
 *
 * Recording is idempotent on the index, so windows may overlap.
 */
async function watch(): Promise<void> {
  if (CHAIN === undefined) return;

  const head = await client.getBlockNumber();
  // Re-scan a little behind the watermark: a reorg or a missed block costs a
  // transfer nobody can retry by hand, and a gap in the ledger makes every
  // segment after it unprovable.
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
    const logs = await client.getLogs({ address: CHAIN, fromBlock: start, toBlock: end });

    for (const log of parseEventLogs({ abi: chainAbi, logs, eventName: 'Transfer' })) {
      const { index, token, minaRecipient, amount, previousHead, newHead } = log.args;
      const recipient = formatMinaAddress(decodeMinaRecipient(minaRecipient));
      await recordTransfer({
        index,
        token,
        recipient,
        amount,
        previousHead,
        newHead,
        flareTxHash: log.transactionHash,
      });

      // The same record, in the table that tracks how far it has got. Which one
      // it lands in is the asset: FMINA is the escrow's, everything else is a
      // port's.
      if (token.toLowerCase() === FMINA) {
        await recordWithdrawal({
          nonce: index,
          recipient,
          amountNanomina: amount,
          flareTxHash: log.transactionHash,
          newActionState: newHead,
        });
      } else {
        await recordLock({
          token,
          claimId: index,
          recipient,
          amount,
          flareTxHash: log.transactionHash,
          newLockState: newHead,
        });
      }
    }
    scannedTo = end;
  }
}

/** One zkApp waiting on the chain head, and the state field that carries it. */
type Consumer = {
  label: string;
  address: string;
  /** `zkappState` index of its accepted Flare head. */
  slot: number;
  publish(attestation: Attestation, inputs: PolicyInputs): Promise<string>;
};

type PolicyInputs = Awaited<ReturnType<typeof policyProofInputs>> & object;

function consumers(): Consumer[] {
  const list: Consumer[] = [];

  if (ESCROW !== undefined) {
    list.push({
      label: 'escrow',
      address: ESCROW,
      // MinaPortBridge: 0 signingPolicyRoot, 1 flareChain, 2 flareActionState.
      slot: 2,
      publish: (attestation, inputs) =>
        publishActionState({
          response: attestation.response.slice(2),
          siblings: attestation.proof.map((p) => p.slice(2)),
          calls: inputs.calls,
          keys: inputs.keys,
        }),
    });
  }

  for (const asset of assets()) {
    list.push({
      label: asset.symbol,
      address: asset.port,
      // AssetPort: 0 signingPolicyRoot, 1 flareLockState, 2 processedLockState.
      slot: 1,
      publish: (attestation, inputs) =>
        publishLockState({
          port: asset.port,
          response: attestation.response.slice(2),
          siblings: attestation.proof.map((p) => p.slice(2)),
          calls: inputs.calls,
          keys: inputs.keys,
        }),
    });
  }

  return list;
}

/**
 * The head a zkApp has actually accepted, read from Mina.
 *
 * Read on chain rather than remembered: a restart would otherwise forget what
 * it had published and send a second transaction for the same head, and the two
 * collide on the fee payer's nonce so one is simply lost. Null when the account
 * cannot be read, which means "do not publish" rather than "publish again".
 */
export async function acceptedHead(address: string, slot: number): Promise<bigint | null> {
  try {
    const res = await fetch(MINA_GRAPHQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `{ account(publicKey: "${address}") { zkappState } }` }),
    });
    const body = (await res.json()) as { data?: { account?: { zkappState?: string[] } } };
    const state = body.data?.account?.zkappState?.[slot];
    return state === undefined ? null : BigInt(state);
  } catch {
    return null;
  }
}

/**
 * Heads already sent and awaiting inclusion, per zkApp.
 *
 * Devnet takes minutes and the account shows the old head for all of them.
 * Without this the next tick sends the same head again and the two fight over
 * the fee payer's nonce. It expires rather than clearing on success: `send()`
 * resolves for a transaction that is then rejected, so a marker held until an
 * exception is a marker held forever.
 */
const inFlight = new Map<string, { head: bigint; at: number }>();

/** Long enough for devnet inclusion, short enough that a rejection is retried. */
const IN_FLIGHT_TTL_MS = Number(process.env.PUBLISH_IN_FLIGHT_TTL_MS ?? 12 * 60_000);

/**
 * Get the round carrying the tip, waiting for it to finalise.
 *
 * Polls inside the tick rather than deferring to the next one: the FDC settles
 * about a minute after a round closes, and the next tick is fifteen away.
 */
async function attestationFor(txHash: `0x${string}`): Promise<Attestation | null> {
  if (CHAIN === undefined) return null;
  const expected = { emitter: CHAIN, topic0: TRANSFER_TOPIC0 };

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

/** Carry the chain head to every zkApp that is behind it. */
async function publish(): Promise<void> {
  if (CHAIN === undefined) return;

  const head = await client.readContract({
    address: CHAIN,
    abi: chainAbi,
    functionName: 'head',
  });
  if (head === 0n) return;

  const behind = [];
  for (const consumer of consumers()) {
    const accepted = await acceptedHead(consumer.address, consumer.slot);
    if (accepted === null || accepted === head) continue;
    const sent = inFlight.get(consumer.address);
    if (sent?.head === head && Date.now() - sent.at < IN_FLIGHT_TTL_MS) continue;
    behind.push(consumer);
  }
  if (behind.length === 0) return;

  // The transaction whose event produced the head. Its `newHead` is what the
  // circuit reads, so the ledger and the chain have to agree before a proof is
  // worth building.
  const txHash = (await transferTxFor(head)) as `0x${string}` | null;
  if (txHash === null) {
    console.warn(`no indexed transfer produced head ${head}; waiting for the watcher`);
    return;
  }

  // Once, for all of them. This is the whole reason the chain is shared: the
  // expensive half of a publication is establishing that the validator set
  // signed a round carrying this head, and that answer does not depend on which
  // asset moved.
  const attestation = await attestationFor(txHash);
  if (attestation === null) return;
  if (attestation.event.newActionState !== head) {
    console.warn('the attested event carries a different head than the chain reports');
    return;
  }

  const inputs = await policyProofInputs(attestation.round);
  if (inputs === null) return;

  for (const consumer of behind) {
    inFlight.set(consumer.address, { head, at: Date.now() });
    try {
      const hash = await consumer.publish(attestation, inputs);
      console.log(`published head ${head} to ${consumer.label} -> ${hash}`);
    } catch (e) {
      // Retry on the next tick rather than stranding this consumer. The others
      // are independent, so one failure must not hold up the rest.
      inFlight.delete(consumer.address);
      console.error(
        `publishing to ${consumer.label} failed:`,
        e instanceof Error ? e.message : e,
      );
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

export function startTransfers(): { stop(): void } {
  if (CHAIN === undefined) {
    console.warn('FLARE_TRANSFER_CHAIN_ADDRESS is not set; the Flare -> Mina rail is off');
    return { stop: () => undefined };
  }

  const loops = [
    loop('transfer watcher', WATCH_MS, watch),
    loop('publisher', PUBLISH_MS, publish),
  ];
  return { stop: () => loops.forEach((l) => l.stop()) };
}
