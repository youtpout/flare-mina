import { createPublicClient, http, parseAbi, parseEventLogs } from 'viem';
import { decodeMinaRecipient, formatMinaAddress } from '@minaport/shared';
import { markWithdrawalReleased, recordWithdrawal, releasableWithdrawals } from './db/index.js';
import { releaseWithdrawal } from './prover/index.js';

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
  'event WithdrawToMina(uint256 indexed nonce, address indexed sender, bytes32 indexed minaRecipient, uint256 amount)',
]);

const client = createPublicClient({ chain: COSTON2, transport: http(RPC) });

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
    const { nonce, minaRecipient, amount } = log.args;
    if (nonce === undefined || minaRecipient === undefined || amount === undefined) continue;

    // Recording is idempotent on the nonce, which the contract makes unique, so
    // an overlapping scan window costs nothing.
    await recordWithdrawal({
      nonce,
      recipient: formatMinaAddress(decodeMinaRecipient(minaRecipient)),
      amountNanomina: amount,
      flareTxHash: log.transactionHash,
    });
  }

  cursor = head + 1n;
}

async function release(): Promise<void> {
  // Oldest first and one at a time: the zkApp requires strictly increasing
  // nonces, so releasing out of order would strand everything behind it.
  const pending = await releasableWithdrawals();

  for (const [index, withdrawal] of pending.entries()) {
    try {
      const hash = await releaseWithdrawal({
        nonce: BigInt(withdrawal.nonce),
        recipient: withdrawal.recipient,
        amountNanomina: BigInt(withdrawal.amount_nanomina),
        // Everything Flare committed to after this one. The proof over it is
        // what authorises the release, so the order here is not a convenience:
        // a tail in the wrong order reaches a different state and is refused.
        tail: pending.slice(index + 1).map((w) => ({
          nonce: BigInt(w.nonce),
          recipient: w.recipient,
          amountNanomina: BigInt(w.amount_nanomina),
        })),
      });
      await markWithdrawalReleased(withdrawal.id, hash);
      console.log(`released withdrawal ${withdrawal.nonce} -> ${withdrawal.recipient}`);
    } catch (e) {
      // Stop at the first failure rather than skipping ahead: the next nonce
      // cannot be released before this one anyway.
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
