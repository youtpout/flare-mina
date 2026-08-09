import { createPublicClient, http, parseAbi, parseEventLogs } from 'viem';
import { decodeMinaRecipient, formatMinaAddress } from '@minaport/shared';
import {
  markWithdrawalReleased,
  markWithdrawalReleasing,
  markWithdrawalsPublished,
  recordWithdrawal,
  releasableWithdrawals,
  transferIndexOf,
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
 * # Why releases go out in waves
 *
 * `releaseWithdrawal` reads the escrow's cursor as a precondition and writes the
 * next one, so releases are ordered — but ordered is not the same as one per
 * block, which is what this used to assume. Mina checks a precondition when the
 * transaction is applied, so a release proved against the cursor its predecessor
 * leaves is valid in the same block. They are still processed oldest-first and a
 * skipped nonce still strands everything behind it; they simply no longer wait
 * minutes between each.
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

/** How many releases go out before anything waits for a block. */
const WAVE = Math.max(1, Number(process.env.RELEASE_WAVE_SIZE ?? 5));

/** How long to keep watching the cursor for a wave that has been sent. */
const CONFIRM_MS = Number(process.env.RELEASE_CONFIRM_MS ?? 8 * 60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Release what the escrow is entitled to, oldest first, in waves.
 *
 * The range is read from the shared ledger rather than from this table: a
 * segment has to replay the transfers of the other three assets too, since
 * stepping over them is exactly what lets one chain serve every rail. Which
 * record gets paid is the circuit's decision, so this only supplies the range
 * and records the outcome.
 *
 * # Why a wave works
 *
 * Mina evaluates a state precondition when the transaction is applied, not
 * against the state at the start of the block — measured, not assumed: five
 * chained transactions on a counter zkApp landed together, nonces 118..122
 * (`packages/mina-contracts/scripts/bumpSpike.ts`). So the prover can build each
 * release against the cursor its predecessor leaves, and the whole wave rides
 * one block instead of one block each.
 *
 * The caller's part is the range. Every release consumes the first record of
 * its own asset, so the next one has to start after it — the chain would not
 * link otherwise. That record is predictable from here, which is the only reason
 * this can hand out ranges for transactions that have not been applied.
 */
async function release(): Promise<void> {
  const pending = await releasableWithdrawals();
  if (pending.length === 0) return;

  const state = await escrowState();
  if (state === null || state.accepted === 0n) return;

  const range = await transferRange(state.cursor, state.accepted);
  if (range === null) {
    console.warn('the transfer ledger has not caught up; retrying next tick');
    return;
  }
  if (range.length === 0) return;

  // A row can outlive its own release: the transaction lands, and the process
  // dies before recording it — which a restart does routinely. The cursor is
  // the truth, so a row the escrow has already moved past is settled, and
  // retrying it forever only produces noise that hides real failures.
  const cursorIndex = await transferIndexOf(state.cursor);
  const fmina = (process.env.FLARE_FMINA_ADDRESS ?? '').toLowerCase();

  let remaining = range;
  const sent: { id: string; nonce: string; recipient: string; hash: string }[] = [];

  for (const withdrawal of pending.slice(0, WAVE)) {
    if (cursorIndex !== null && BigInt(withdrawal.nonce) <= cursorIndex) {
      await markWithdrawalReleased(withdrawal.id, withdrawal.mina_tx_hash ?? 'recovered');
      console.log(`withdrawal ${withdrawal.nonce} was already released; catching the row up`);
      continue;
    }

    // The record the circuit will pick, and where the next range must resume.
    const at = remaining.findIndex((r) => r.token.toLowerCase() === fmina);
    if (at === -1) break;

    try {
      await markWithdrawalReleasing(withdrawal.id);
      const hash = await releaseWithdrawal({
        range: remaining.map((r) => ({
          index: BigInt(r.chain_index),
          token: r.token,
          recipient: r.recipient,
          amount: BigInt(r.amount),
        })),
        wave: true,
        restart: sent.length === 0,
      });
      sent.push({
        id: withdrawal.id,
        nonce: withdrawal.nonce,
        recipient: withdrawal.recipient,
        hash,
      });
      remaining = remaining.slice(at + 1);
    } catch (e) {
      // Stop at the first failure rather than skipping ahead: everything behind
      // it was built against a cursor that will now never arrive. The rows stay
      // `releasing`, and the next tick rebuilds them from the chain.
      console.error(
        `withdrawal ${withdrawal.nonce} not released:`,
        e instanceof Error ? e.message : e,
      );
      break;
    }
  }

  if (sent.length > 0) await confirm(sent);
}

/**
 * Settle a wave against the cursor, which is the only thing that says a release
 * happened.
 *
 * `send()` resolves for a transaction that is later rejected, so a hash proves
 * nothing. Rows are marked released as the cursor passes their index; whatever
 * the cursor never reaches stays `releasing` and is picked up again next tick,
 * rebuilt from the state the chain actually has. That is the whole retry: no
 * bookkeeping about which transaction of the wave failed, because a survivor is
 * indistinguishable from a row that was never sent once the cursor has spoken.
 */
async function confirm(sent: { id: string; nonce: string; recipient: string; hash: string }[]) {
  console.log(`sent a wave of ${sent.length} release(s); waiting on the cursor`);

  const outstanding = new Map(sent.map((s) => [s.id, s]));
  const deadline = Date.now() + CONFIRM_MS;

  while (outstanding.size > 0 && Date.now() < deadline) {
    await sleep(15_000);

    const state = await escrowState();
    if (state === null) continue;
    const index = await transferIndexOf(state.cursor);
    if (index === null) continue;

    for (const [id, row] of outstanding) {
      if (BigInt(row.nonce) > index) continue;
      await markWithdrawalReleased(id, row.hash);
      console.log(`released withdrawal ${row.nonce} -> ${row.recipient}`);
      outstanding.delete(id);
    }
  }

  for (const row of outstanding.values()) {
    console.warn(`withdrawal ${row.nonce} (${row.hash}) has not moved the cursor; will retry`);
  }
}

export function startWithdrawals(): { stop(): void } {
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
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
