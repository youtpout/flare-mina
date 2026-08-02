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

export type DepositStatus = 'awaiting-confirmations' | 'attested' | 'claimed' | 'failed';

export type DepositRow = {
  id: string;
  mina_tx_hash: string;
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
 * Record a newly observed payment.
 *
 * `ON CONFLICT DO NOTHING` on the transaction hash is the idempotency guard:
 * the watcher may see the same payment twice across a restart or an overlapping
 * poll window, and attesting it twice would be a double mint.
 */
export async function recordDeposit(input: {
  minaTxHash: string;
  minaSender: string;
  recipient: string;
  amountNanomina: bigint;
  nonce: bigint;
  blockHeight: number;
}): Promise<DepositRow | null> {
  const { rows } = await pool.query<DepositRow>(
    `INSERT INTO deposits
       (mina_tx_hash, mina_sender, recipient, amount_nanomina, nonce,
        mina_block_height, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'awaiting-confirmations')
     ON CONFLICT (mina_tx_hash) DO NOTHING
     RETURNING *`,
    [
      input.minaTxHash,
      input.minaSender,
      input.recipient,
      input.amountNanomina.toString(),
      input.nonce.toString(),
      input.blockHeight,
    ],
  );
  return rows[0] ?? null;
}

export async function markAttested(minaTxHash: string, attestation: string): Promise<void> {
  await pool.query(
    `UPDATE deposits
        SET status = 'attested', attestation = $2, reason = NULL, updated_at = now()
      WHERE mina_tx_hash = $1 AND status = 'awaiting-confirmations'`,
    [minaTxHash, attestation],
  );
}

export async function markFailed(minaTxHash: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE deposits SET status = 'failed', reason = $2, updated_at = now()
      WHERE mina_tx_hash = $1`,
    [minaTxHash, reason],
  );
}

export async function markClaimed(minaTxHash: string, flareTxHash: string): Promise<void> {
  await pool.query(
    `UPDATE deposits SET status = 'claimed', flare_tx_hash = $2, updated_at = now()
      WHERE mina_tx_hash = $1`,
    [minaTxHash, flareTxHash],
  );
}

export async function depositsFor(minaSender: string): Promise<DepositRow[]> {
  const { rows } = await pool.query<DepositRow>(
    `SELECT * FROM deposits WHERE mina_sender = $1 ORDER BY id DESC LIMIT 50`,
    [minaSender],
  );
  return rows;
}

/** Next nonce for a sender, derived from what has already been recorded. */
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
