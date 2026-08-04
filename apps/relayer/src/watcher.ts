import { privateKeyToAccount } from 'viem/accounts';
import { encodeMinaRecipient, parseMinaAddress } from '@minaport/shared';
import { intentDigest } from './attestor.js';
import { markAttested, markFailed, submittedDeposits, type DepositRow } from './db/index.js';

/**
 * Inclusion poller.
 *
 * Works through deposits the wallet has broadcast and attests the ones that
 * landed. It does not discover deposits — the relayer built them, so it already
 * knows every field. That is what removes the archive-node dependency: there is
 * nothing to reconstruct from the chain, only a yes/no to confirm.
 *
 * # What it can and cannot do
 *
 * It cannot redirect or inflate a deposit. The recipient and amount are inside
 * the depositor's Schnorr signature, which the Flare contract verifies against
 * the Pallas curve. A dishonest poller can only refuse to sign, or sign for an
 * escrow that never happened — GAP 1 in docs/threat-model.md, bounded on chain
 * by the mint ceilings.
 *
 * # How inclusion is decided
 *
 * By the depositor's own account nonce passing the one their transaction used.
 * Mina serialises a single account's transactions behind that nonce, so once it
 * has advanced, that transaction either landed or was permanently displaced —
 * and a displaced one leaves the escrow untouched, so re-checking the balance
 * separates the two.
 *
 * The precise signal would be reading the dispatched action back and matching
 * it, which needs an archive node. Neither Minascan's nor MinaExplorer's was
 * reachable when this was written, so this is the honest substitute.
 */

const GRAPHQL = process.env.MINA_GRAPHQL ?? 'https://mina-devnet-graphql.aurowallet.com/graphql';
const POLL_MS = Number(process.env.WATCH_INTERVAL_MS ?? 20_000);
const CHAIN_ID = BigInt(process.env.FLARE_CHAIN_ID ?? 114);
const BRIDGE = process.env.MINA_BRIDGE_ACCOUNT ?? '';

/** Largest deposit this attestor will sign for, in nanomina. */
const MAX_ATTESTED = BigInt(process.env.MAX_DEPOSIT_NANOMINA ?? 1_000_000_000_000n);
/** Smallest one worth the gas of a claim. */
const MIN_ATTESTED = BigInt(process.env.MIN_DEPOSIT_NANOMINA ?? 100_000_000n);

const ACCOUNT_QUERY = `
  query Account($publicKey: PublicKey!) {
    account(publicKey: $publicKey) {
      nonce
      balance { total }
    }
  }
`;

type AccountState = { nonce: number; balanceNanomina: bigint } | null;

async function accountState(publicKey: string): Promise<AccountState> {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: ACCOUNT_QUERY, variables: { publicKey } }),
  });
  if (!res.ok) throw new Error(`Mina node returned ${res.status}`);

  const body = (await res.json()) as {
    data?: { account?: { nonce: string; balance: { total: string } } | null };
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));

  const account = body.data?.account;
  if (!account) return null;
  return { nonce: Number(account.nonce), balanceNanomina: BigInt(account.balance.total) };
}

function attestorAccount() {
  const key = process.env.ATTESTOR_PRIVATE_KEY;
  if (!key) throw new Error('ATTESTOR_PRIVATE_KEY is not set');
  return privateKeyToAccount(key as `0x${string}`);
}

/**
 * The policy bounds. They are the honest attestor restraining itself and are
 * worth nothing against a compromised key — which is exactly why the same
 * ceilings exist on chain, in `MinaPortBridge`, where the key cannot ignore
 * them.
 */
function withinPolicy(deposit: DepositRow): string | null {
  const amount = BigInt(deposit.amount_nanomina);
  if (amount < MIN_ATTESTED) return 'amount below the minimum';
  if (amount > MAX_ATTESTED) return 'amount above the per-deposit ceiling';
  return null;
}

async function tick(): Promise<void> {
  const deposits = await submittedDeposits();
  if (deposits.length === 0) return;

  const account = attestorAccount();
  const escrow = BRIDGE ? await accountState(BRIDGE) : null;

  for (const deposit of deposits) {
    const rejection = withinPolicy(deposit);
    if (rejection !== null) {
      await markFailed(deposit.id, rejection);
      continue;
    }

    // The escrow must hold at least this deposit. A far weaker statement than
    // "this deposit is in there", and deliberately not dressed up as more.
    if (escrow !== null && escrow.balanceNanomina < BigInt(deposit.amount_nanomina)) {
      continue;
    }

    const signature = await account.signMessage({
      message: {
        raw: intentDigest(CHAIN_ID, {
          minaSender: deposit.mina_sender as `0x${string}`,
          recipient: deposit.recipient as `0x${string}`,
          amountNanomina: BigInt(deposit.amount_nanomina),
          nonce: BigInt(deposit.nonce),
        }),
      },
    });

    await markAttested(deposit.id, signature);
    console.log(`attested deposit ${deposit.id} -> ${deposit.recipient}`);
  }
}

export function startWatcher(): { stop(): void } {
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        await tick();
      } catch (e) {
        // A failing poll must not kill the loop: nodes go down, rate limits
        // happen, and the next tick should simply try again.
        console.error('poller tick failed:', e instanceof Error ? e.message : e);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };

  void loop();
  return { stop: () => (stopped = true) };
}

/** Exposed for the sender-nonce check in tests and future tightening. */
export { accountState, encodeMinaRecipient, parseMinaAddress };
