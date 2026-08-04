import { createPublicClient, http, parseAbi } from 'viem';
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
const LOOKBACK = BigInt(process.env.WITHDRAWAL_LOOKBACK_BLOCKS ?? 50_000);

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

  const logs = await client.getLogs({
    address: BRIDGE,
    event: bridgeAbi[0],
    fromBlock: from,
    toBlock: head,
  });

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

  for (const withdrawal of pending) {
    try {
      const hash = await releaseWithdrawal({
        nonce: BigInt(withdrawal.nonce),
        recipient: withdrawal.recipient,
        amountNanomina: BigInt(withdrawal.amount_nanomina),
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
