import { createPublicClient, http, parseAbi, parseEventLogs } from 'viem';
import { decodeMinaRecipient, formatMinaAddress } from '@minaport/shared';
import {
  markWithdrawalReleased,
  markWithdrawalReleasing,
  markWithdrawalsPublished,
  recordWithdrawal,
  releasableWithdrawals,
  transferRange,
} from './db/index.js';
import { releaseWithdrawal } from './prover/index.js';
import { acceptedHead } from './transfers.js';

/**
 * The Flare -> Mina return path.
 *
 * Burning FMINA emits `WithdrawToMina` with a monotonic nonce; this watches for
 * that event and releases the matching MINA from the escrow zkApp.
 *
 * # What is trusted, and what is not
 *
 * The burn is the authorisation and it already happened on chain: the user's
 * FMINA is gone before this service sees anything, and the event carries the
 * recipient and the amount. This service cannot invent a withdrawal that no
 * burn produced *without* the withdrawal attestor's key, which co-signs the
 * release — and it cannot redirect one either, since the recipient is inside
 * the record whose hash the zkApp checks.
 *
 * What it can do, holding that key, is attest to a burn that never happened.
 * That is GAP 2 in docs/threat-model.md, the mirror of the inbound attestor,
 * and it is bounded on the Mina side: a release cannot exceed the escrowed
 * balance, and nonces must strictly increase.
 *
 * # Why releases are serialised
 *
 * `releaseWithdrawal` reads and writes `lastWithdrawalNonce`, so two releases
 * in one block conflict — one per block, unavoidably. Deposits are concurrent
 * because they read no state; withdrawals cannot be. They are therefore
 * processed oldest-first, one at a time, and a skipped nonce would strand
 * everything behind it.
 */

const RPC = process.env.COSTON2_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const BRIDGE = process.env.FLARE_BRIDGE_ADDRESS as `0x${string}` | undefined;
const POLL_MS = Number(process.env.WITHDRAWAL_INTERVAL_MS ?? 20_000);

/** How far back to look on a cold start, in blocks. */
const LOOKBACK = BigInt(process.env.WITHDRAWAL_LOOKBACK_BLOCKS ?? 3_000);

/**
 * Blocks per `getLogs` call.
 *
 * Thirty, because that is the cap the Coston2 public RPC enforces. It reports
 * it as "Missing or invalid parameters", and only says what it means if you
 * read `error.details`: *requested too many blocks, maximum is set to 30*.
 *
 * Steady state is unaffected — at ~2s blocks and a 20s poll the cursor trails
 * about ten blocks — so this only lengthens a cold start, which is why the
 * lookback is a few thousand blocks rather than tens of thousands.
 */
const CHUNK = BigInt(process.env.WITHDRAWAL_CHUNK_BLOCKS ?? 30);

const COSTON2 = {
  id: 114,
  name: 'Coston2',
  nativeCurrency: { name: 'Coston2 Flare', symbol: 'C2FLR', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const bridgeAbi = parseAbi([
  // Must match the contract exactly: parseEventLogs filters on topic0, which is
  // the keccak of this signature, so a missing field makes every burn invisible
  // rather than mis-decoded — silence, not an error.
  'event WithdrawToMina(uint256 indexed nonce, address indexed token, address indexed sender, bytes32 minaRecipient, uint256 amount, uint256 previousActionState, uint256 newActionState)',
]);

const client = createPublicClient({ chain: COSTON2, transport: http(RPC) });

const MINA_GRAPHQL =
  process.env.MINA_DEVNET_GRAPHQL ?? 'https://api.minascan.io/node/devnet/v1/graphql';
const ESCROW = process.env.MINA_BRIDGE_ACCOUNT;

/**
 * `zkappState` by field order in MinaPortBridge.ts: 0 signingPolicyRoot,
 * 1 flareChain, 2 flareActionState, 3 processedActionState.
 *
 * Reading the wrong index once returned `processedActionState`, which is always
 * a head the escrow has already covered — so nothing was ever promoted and
 * every withdrawal sat at "waiting for FDC" while the publisher worked.
 */
async function escrowState(): Promise<{ accepted: bigint; cursor: bigint } | null> {
  if (ESCROW === undefined) return null;
  try {
    const res = await fetch(MINA_GRAPHQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `{ account(publicKey: "${ESCROW}") { zkappState } }` }),
    });
    const body = (await res.json()) as { data?: { account?: { zkappState?: string[] } } };
    const state = body.data?.account?.zkappState;
    if (state?.[2] === undefined || state[3] === undefined) return null;
    return { accepted: BigInt(state[2]), cursor: BigInt(state[3]) };
  } catch {
    return null;
  }
}

/** Last block scanned, so a restart does not re-read the whole chain. */
let cursor: bigint | undefined;

async function scan(): Promise<void> {
  if (BRIDGE === undefined) return;

  const head = await client.getBlockNumber();
  const from = cursor ?? (head > LOOKBACK ? head - LOOKBACK : 0n);
  if (from > head) return;

  const raw = [];
  for (let start = from; start <= head; start += CHUNK) {
    const end = start + CHUNK - 1n > head ? head : start + CHUNK - 1n;
    raw.push(...(await client.getLogs({ address: BRIDGE, fromBlock: start, toBlock: end })));
  }

  // `parseEventLogs` keeps only what matches and drops the rest, so an
  // unrelated event from the same contract is ignored rather than mis-decoded.
  const logs = parseEventLogs({ abi: bridgeAbi, eventName: 'WithdrawToMina', logs: raw });

  for (const log of logs) {
    const { nonce, minaRecipient, amount, newActionState } = log.args;
    if (
      nonce === undefined ||
      minaRecipient === undefined ||
      amount === undefined ||
      newActionState === undefined
    ) {
      continue;
    }

    // Recording is idempotent on the nonce, which the contract makes unique, so
    // an overlapping scan window costs nothing.
    await recordWithdrawal({
      nonce,
      recipient: formatMinaAddress(decodeMinaRecipient(minaRecipient)),
      amountNanomina: amount,
      flareTxHash: log.transactionHash,
      newActionState,
    });
  }

  cursor = head + 1n;
}

/**
 * Promote burns Mina has accepted a covering state for.
 *
 * Reading it here rather than trusting the publisher's own report: what matters
 * is what the escrow accepted, not what was sent, and the two differ for the
 * minutes an inclusion takes.
 */
async function refreshCoverage(): Promise<void> {
  const state = await escrowState();
  if (state === null || state.accepted === 0n) return;
  const promoted = await markWithdrawalsPublished(state.accepted);
  if (promoted > 0) console.log(`${promoted} withdrawal(s) now covered by an accepted state`);
}

/**
 * Release what the escrow is entitled to, oldest first and one at a time.
 *
 * The range is read from the shared ledger rather than from this table: a
 * segment has to replay the transfers of the other three assets too, since
 * stepping over them is exactly what lets one chain serve every rail. Which
 * record gets paid is the circuit's decision, so this only supplies the range
 * and records the outcome.
 */
async function release(): Promise<void> {
  const pending = await releasableWithdrawals();
  if (pending.length === 0) return;

  for (const withdrawal of pending) {
    // Re-read every iteration: the previous release moved the cursor, and a
    // range starting where the escrow no longer is would simply be refused.
    const state = await escrowState();
    if (state === null || state.accepted === 0n) return;

    const range = await transferRange(state.cursor, state.accepted);
    if (range === null) {
      console.warn('the transfer ledger has not caught up; retrying next tick');
      return;
    }
    if (range.length === 0) return;

    try {
      await markWithdrawalReleasing(withdrawal.id);
      const hash = await releaseWithdrawal({
        range: range.map((r) => ({
          index: BigInt(r.chain_index),
          token: r.token,
          recipient: r.recipient,
          amount: BigInt(r.amount),
        })),
      });
      await markWithdrawalReleased(withdrawal.id, hash);
      console.log(`released withdrawal ${withdrawal.nonce} -> ${withdrawal.recipient}`);
    } catch (e) {
      // Stop at the first failure rather than skipping ahead: the next
      // withdrawal sits behind this one in the chain anyway.
      console.error(
        `withdrawal ${withdrawal.nonce} not released:`,
        e instanceof Error ? e.message : e,
      );
      return;
    }
  }
}

export function startWithdrawals(): { stop(): void } {
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        await scan();
        await refreshCoverage();
        await release();
      } catch (e) {
        console.error('withdrawal tick failed:', e instanceof Error ? e.message : e);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };

  void loop();
  return { stop: () => (stopped = true) };
}
