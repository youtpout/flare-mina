import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Postgres access.
 *
 * The database is a cache of what the watcher has seen, not a source of truth.
 * The escrow lives on Mina and the mint authority lives in a Flare contract, so
 * losing this database costs a resync rather than funds. That is deliberate:
 * it means the service can be redeployed, moved, or wiped without ceremony.
 */

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Coolify runs Postgres on the internal network, where TLS is neither
  // required nor available. Set PGSSL=require for a managed provider.
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
  max: 8,
});

export async function migrate(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

export type DepositStatus = 'built' | 'submitted' | 'attested' | 'claimed' | 'failed' | 'aborted';

export type DepositRow = {
  id: string;
  mina_tx_hash: string | null;
  mina_sender: string;
  recipient: string;
  amount_nanomina: string;
  nonce: string;
  status: DepositStatus;
  reason: string | null;
  attestation: string | null;
  flare_tx_hash: string | null;
};

/**
 * Record a deposit the prover has just built, before the wallet has seen it.
 *
 * Recording here rather than after broadcast is what makes the service
 * restartable: the row exists before the transaction can possibly land, so a
 * relayer that dies between building and inclusion still knows what to look
 * for when it comes back. The alternative — learning about deposits by
 * watching the chain — needs an archive node we do not have.
 */
export async function recordBuilt(input: {
  minaSender: string;
  recipient: string;
  amountNanomina: bigint;
  nonce: bigint;
}): Promise<DepositRow> {
  const { rows } = await pool.query<DepositRow>(
    `INSERT INTO deposits (mina_sender, recipient, amount_nanomina, nonce, status)
     VALUES ($1, $2, $3, $4, 'built')
     RETURNING *`,
    [input.minaSender, input.recipient, input.amountNanomina.toString(), input.nonce.toString()],
  );
  return rows[0]!;
}

/** The wallet has broadcast; from here the poller looks for inclusion. */
export async function markSubmitted(id: string, minaTxHash: string): Promise<void> {
  await pool.query(
    `UPDATE deposits SET status = 'submitted', mina_tx_hash = $2, updated_at = now()
      WHERE id = $1 AND status = 'built'`,
    [id, minaTxHash],
  );
}

export async function markAttested(id: string, attestation: string): Promise<void> {
  await pool.query(
    `UPDATE deposits
        SET status = 'attested', attestation = $2, reason = NULL, updated_at = now()
      WHERE id = $1 AND status = 'submitted'`,
    [id, attestation],
  );
}

export async function markFailed(id: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE deposits SET status = 'failed', reason = $2, updated_at = now() WHERE id = $1`,
    [id, reason],
  );
}

export async function markClaimed(id: string, flareTxHash: string): Promise<void> {
  await pool.query(
    `UPDATE deposits SET status = 'claimed', flare_tx_hash = $2, updated_at = now()
      WHERE id = $1`,
    [id, flareTxHash],
  );
}

/** Deposits broadcast but not yet attested — what the poller works through. */
export async function submittedDeposits(): Promise<DepositRow[]> {
  const { rows } = await pool.query<DepositRow>(
    `SELECT * FROM deposits WHERE status = 'submitted' ORDER BY id ASC LIMIT 50`,
  );
  return rows;
}

export async function depositsFor(minaSender: string): Promise<DepositRow[]> {
  const { rows } = await pool.query<DepositRow>(
    `SELECT * FROM deposits WHERE mina_sender = $1 ORDER BY id DESC LIMIT 50`,
    [minaSender],
  );
  return rows;
}

/**
 * Next nonce for a sender.
 *
 * Only has to be unique, not sequential — but deriving it from what we have
 * recorded is the cheapest way to be sure, and it keeps the numbers readable
 * in the UI.
 */
export async function nextNonceFor(minaSender: string): Promise<bigint> {
  const { rows } = await pool.query<{ next: string }>(
    `SELECT COALESCE(MAX(nonce) + 1, 0)::text AS next FROM deposits WHERE mina_sender = $1`,
    [minaSender],
  );
  return BigInt(rows[0]?.next ?? '0');
}

export async function getWatermark(): Promise<number> {
  const { rows } = await pool.query<{ last_height: string }>(
    `SELECT last_height FROM watermark WHERE id = 1`,
  );
  return Number(rows[0]?.last_height ?? 0);
}

export async function setWatermark(height: number): Promise<void> {
  await pool.query(
    `UPDATE watermark SET last_height = $1, updated_at = now() WHERE id = 1`,
    [height],
  );
}

export type WithdrawalRow = {
  id: string;
  nonce: string;
  recipient: string;
  amount_nanomina: string;
  flare_tx_hash: string;
  mina_tx_hash: string | null;
  status: 'pending' | 'released' | 'failed';
  reason: string | null;
};

/**
 * Record a burn seen on Flare.
 *
 * Idempotent on the nonce, which the bridge contract makes unique, so
 * overlapping scan windows are free.
 */
export async function recordWithdrawal(input: {
  nonce: bigint;
  recipient: string;
  amountNanomina: bigint;
  flareTxHash: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO withdrawals (nonce, recipient, amount_nanomina, flare_tx_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (nonce) DO NOTHING`,
    [
      input.nonce.toString(),
      input.recipient,
      input.amountNanomina.toString(),
      input.flareTxHash,
    ],
  );
}

/** Burns awaiting release, oldest nonce first — the order the zkApp demands. */
export async function releasableWithdrawals(): Promise<WithdrawalRow[]> {
  const { rows } = await pool.query<WithdrawalRow>(
    `SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY nonce ASC LIMIT 20`,
  );
  return rows;
}

export async function markWithdrawalReleased(id: string, minaTxHash: string): Promise<void> {
  await pool.query(
    `UPDATE withdrawals SET status = 'released', mina_tx_hash = $2, updated_at = now()
      WHERE id = $1`,
    [id, minaTxHash],
  );
}

/** Withdrawals for one Mina account, for the UI. */
export async function withdrawalsFor(recipient: string): Promise<WithdrawalRow[]> {
  const { rows } = await pool.query<WithdrawalRow>(
    `SELECT * FROM withdrawals WHERE recipient = $1 ORDER BY nonce DESC LIMIT 50`,
    [recipient],
  );
  return rows;
}


/** Remember a validator's public key, keyed by the address it hashes to. */
export async function rememberValidatorKeys(
  keys: Array<{ address: string; publicKey: string }>,
): Promise<void> {
  if (keys.length === 0) return;
  await pool.query(
    `INSERT INTO validator_keys (address, public_key)
       SELECT * FROM UNNEST($1::text[], $2::text[])
     ON CONFLICT (address) DO UPDATE SET last_seen = now()`,
    [keys.map((k) => k.address.toLowerCase()), keys.map((k) => k.publicKey)],
  );
}

/** Every validator key seen so far, address -> uncompressed public key. */
export async function knownValidatorKeys(): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ address: string; public_key: string }>(
    'SELECT address, public_key FROM validator_keys',
  );
  return new Map(rows.map((r) => [r.address.toLowerCase(), r.public_key]));
}
