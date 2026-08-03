import { privateKeyToAccount } from 'viem/accounts';
import { encodeMinaRecipient, parseMinaAddress } from '@minaport/shared';
import {
  evaluate,
  intentDigest,
  type AttestorPolicy,
  type MinaPayment,
} from './attestor.js';
import { getWatermark, markAttested, markFailed, nextNonceFor, recordDeposit, setWatermark } from './db/index.js';

/**
 * The Mina watcher.
 *
 * Polls for payments into the escrow account, records them, and signs an
 * attestation once they are buried deeply enough. This is the cron the whole
 * inbound path hangs off.
 *
 * It cannot redirect or inflate a deposit — the depositor's Schnorr signature
 * covers the recipient and the amount and the contract checks it. What it can
 * do, and what makes it the trusted component, is attest to an escrow that
 * never happened. That is why it is a separate, small, auditable service rather
 * than something bolted onto the API.
 */

const GRAPHQL = process.env.MINA_GRAPHQL ?? 'https://api.minascan.io/node/devnet/v1/graphql';
const POLL_MS = Number(process.env.WATCH_INTERVAL_MS ?? 20_000);
const CHAIN_ID = BigInt(process.env.FLARE_CHAIN_ID ?? 114);

const POLICY: AttestorPolicy = {
  bridgeAddress: process.env.MINA_BRIDGE_ACCOUNT ?? '',
  // Depth guards against a reorg reverting an escrow we have already attested
  // to. Two is a demo setting: Mina devnet produces a block every few minutes,
  // so a deeper threshold puts an hour between a deposit and its attestation.
  // Raise it for any deployment holding value.
  confirmations: Number(process.env.MINA_CONFIRMATIONS ?? 2),
  minAmountNanomina: BigInt(process.env.MIN_DEPOSIT_NANOMINA ?? 100_000_000n),
  maxAmountNanomina: BigInt(process.env.MAX_DEPOSIT_NANOMINA ?? 1_000_000_000_000n),
};

/**
 * Payments into the escrow account.
 *
 * Minascan's schema is used rather than a node's own, because a node only knows
 * about transactions it has in its pool or recent blocks — an indexer is what
 * can answer "everything ever sent here".
 */
const QUERY = `
  query Deposits($to: String!, $limit: Int!) {
    transactions(query: { to: $to, canonical: true }, limit: $limit, sortBy: BLOCKHEIGHT_DESC) {
      hash
      from
      to
      amount
      memo
      blockHeight
    }
  }
`;

type GraphQLTransaction = {
  hash: string;
  from: string;
  to: string;
  amount: string | number;
  memo: string | null;
  blockHeight: number;
};

async function fetchPayments(limit = 50): Promise<GraphQLTransaction[]> {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { to: POLICY.bridgeAddress, limit } }),
  });
  if (!res.ok) throw new Error(`Mina indexer returned ${res.status}`);

  const body = (await res.json()) as {
    data?: { transactions?: GraphQLTransaction[] };
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data?.transactions ?? [];
}

function attestorAccount() {
  const key = process.env.ATTESTOR_PRIVATE_KEY;
  if (!key) throw new Error('ATTESTOR_PRIVATE_KEY is not set');
  return privateKeyToAccount(key as `0x${string}`);
}

async function tick(): Promise<void> {
  if (!POLICY.bridgeAddress) throw new Error('MINA_BRIDGE_ACCOUNT is not set');

  const account = attestorAccount();
  const transactions = await fetchPayments();
  if (transactions.length === 0) return;

  const chainHeight = Math.max(...transactions.map((t) => t.blockHeight));

  // Oldest first, so nonces are assigned in the order deposits happened.
  for (const tx of [...transactions].reverse()) {
    const packedSender = encodeMinaRecipient(parseMinaAddress(tx.from));

    const payment: MinaPayment = {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      amountNanomina: BigInt(tx.amount),
      memo: tx.memo ?? '',
      blockHeight: tx.blockHeight,
    };

    // Assign the nonce first: recording is idempotent on the transaction hash,
    // so a crash between here and the attestation replays harmlessly.
    const nonce = await nextNonceFor(packedSender);
    const inserted = await recordDeposit({
      minaTxHash: tx.hash,
      minaSender: packedSender,
      recipient: '0x0000000000000000000000000000000000000000',
      amountNanomina: payment.amountNanomina,
      nonce,
      blockHeight: tx.blockHeight,
    });
    if (!inserted) continue; // already seen

    const decision = evaluate(payment, chainHeight, POLICY, packedSender, nonce);
    if (!decision.ok) {
      // Not necessarily terminal — "too few confirmations" resolves itself —
      // but the reason is recorded so the UI can explain the wait.
      await markFailed(tx.hash, decision.reason);
      continue;
    }

    const signature = await account.signMessage({
      message: { raw: intentDigest(CHAIN_ID, decision.target) },
    });
    await markAttested(tx.hash, signature);
    console.log(`attested ${tx.hash} -> ${decision.target.recipient}`);
  }

  await setWatermark(chainHeight);
}

export function startWatcher(): { stop(): void } {
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        await tick();
      } catch (e) {
        // A failing poll must not kill the watcher: the indexer goes down, rate
        // limits happen, and the next tick should simply try again.
        console.error('watcher tick failed:', e instanceof Error ? e.message : e);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };

  void getWatermark().then(() => void loop());
  return { stop: () => (stopped = true) };
}
