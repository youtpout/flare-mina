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
/** The shared chain a row belongs to. Rows from before it are left NULL. */
const CHAIN = (process.env.FLARE_TRANSFER_CHAIN_ADDRESS ?? '').toLowerCase() || null;

export async function recordWithdrawal(input: {
  nonce: bigint;
  recipient: string;
  amountNanomina: bigint;
  flareTxHash: string;
  newActionState: bigint;
}): Promise<void> {
  await pool.query(
    `INSERT INTO withdrawals
       (chain, nonce, recipient, amount_nanomina, flare_tx_hash, new_action_state)
     VALUES ($1, $2, $3, $4, $5, $6)
     -- Backfill rather than DO NOTHING: rows recorded before this column
     -- existed would otherwise never gain a state, and so never be releasable.
     ON CONFLICT (chain, nonce) DO UPDATE SET new_action_state = EXCLUDED.new_action_state
       WHERE withdrawals.new_action_state IS NULL`,
    [
      CHAIN,
      input.nonce.toString(),
      input.recipient,
      input.amountNanomina.toString(),
      input.flareTxHash,
      input.newActionState.toString(),
    ],
  );
}

/** Burns awaiting release, oldest nonce first — the order the zkApp demands. */
/** Only what Mina has already accepted a covering state for. */
export async function releasableWithdrawals(): Promise<WithdrawalRow[]> {
  const { rows } = await pool.query<WithdrawalRow>(
    `SELECT * FROM withdrawals WHERE status IN ('published','releasing')
      ORDER BY nonce ASC LIMIT 20`,
  );
  return rows;
}

/**
 * Mark every withdrawal covered by an accepted chain state.
 *
 * The state is a hash, so it cannot be compared for order — but the row whose
 * own `new_action_state` equals it is the last one it covers, and nonces are
 * monotonic, so everything below is covered too.
 */
export async function markWithdrawalsPublished(acceptedState: bigint): Promise<number> {
  const { rows } = await pool.query<{ nonce: string }>(
    `SELECT nonce FROM withdrawals WHERE new_action_state = $1`,
    [acceptedState.toString()],
  );
  const upTo = rows[0]?.nonce;
  if (upTo === undefined) return 0;

  const { rowCount } = await pool.query(
    `UPDATE withdrawals SET status = 'published', updated_at = now()
      WHERE status = 'seen' AND nonce <= $1`,
    [upTo],
  );
  return rowCount ?? 0;
}

export async function markWithdrawalReleasing(id: string): Promise<void> {
  await pool.query(
    `UPDATE withdrawals SET status = 'releasing', updated_at = now() WHERE id = $1`,
    [id],
  );
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

export type LockRow = {
  id: string;
  token: string;
  claim_id: string;
  recipient: string;
  amount: string;
  flare_tx_hash: string;
  mina_tx_hash: string | null;
  status: 'seen' | 'published' | 'minting' | 'minted' | 'failed';
  reason: string | null;
  new_lock_state: string | null;
};

/**
 * Record a lock seen on Flare. Idempotent on (token, claim id), which the vault
 * makes unique, so overlapping scan windows are free.
 */
export async function recordLock(input: {
  token: string;
  claimId: bigint;
  recipient: string;
  amount: bigint;
  flareTxHash: string;
  newLockState: bigint;
}): Promise<void> {
  await pool.query(
    `INSERT INTO locks
       (chain, token, claim_id, recipient, amount, flare_tx_hash, new_lock_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chain, token, claim_id) DO NOTHING`,
    [
      CHAIN,
      input.token.toLowerCase(),
      input.claimId.toString(),
      input.recipient,
      input.amount.toString(),
      input.flareTxHash,
      input.newLockState.toString(),
    ],
  );
}

/**
 * Mark every lock on one token covered by an accepted head.
 *
 * A head is a hash and cannot be compared for order, but the row whose own
 * `new_lock_state` equals it is the last one it covers, and claim ids are
 * monotonic within a token, so everything below is covered too.
 */
export async function markLocksPublished(token: string, acceptedState: bigint): Promise<number> {
  const { rows } = await pool.query<{ claim_id: string }>(
    `SELECT claim_id FROM locks WHERE token = $1 AND new_lock_state = $2`,
    [token.toLowerCase(), acceptedState.toString()],
  );
  const upTo = rows[0]?.claim_id;
  if (upTo === undefined) return 0;

  const { rowCount } = await pool.query(
    `UPDATE locks SET status = 'published', updated_at = now()
      WHERE token = $1 AND status = 'seen' AND claim_id <= $2`,
    [token.toLowerCase(), upTo],
  );
  return rowCount ?? 0;
}

/** Locks awaiting a mint, oldest claim first — the order the port demands. */
export async function mintableLocks(token: string): Promise<LockRow[]> {
  const { rows } = await pool.query<LockRow>(
    `SELECT * FROM locks WHERE token = $1 AND status IN ('published','minting')
      ORDER BY claim_id ASC LIMIT 20`,
    [token.toLowerCase()],
  );
  return rows;
}

export async function markLockMinting(id: string): Promise<void> {
  await pool.query(`UPDATE locks SET status = 'minting', updated_at = now() WHERE id = $1`, [id]);
}

export async function markLockMinted(id: string, minaTxHash: string): Promise<void> {
  await pool.query(
    `UPDATE locks SET status = 'minted', mina_tx_hash = $2, updated_at = now() WHERE id = $1`,
    [id, minaTxHash],
  );
}

export async function markLockFailed(id: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE locks SET status = 'failed', reason = $2, updated_at = now() WHERE id = $1`,
    [id, reason],
  );
}

/** Locks headed for one Mina account, for the UI. */
export async function locksFor(recipient: string): Promise<LockRow[]> {
  const { rows } = await pool.query<LockRow>(
    `SELECT * FROM locks WHERE recipient = $1 ORDER BY id DESC LIMIT 50`,
    [recipient],
  );
  return rows;
}

/**
 * The Flare transaction whose event produced a given chain state.
 *
 * Keyed on `new_action_state` rather than on ordering: the state is what the
 * circuit reads out of the attested event, so matching on it is the only way to
 * be sure the attestation and the publication are about the same withdrawal.
 */
export async function withdrawalTxFor(actionState: bigint): Promise<string | null> {
  const { rows } = await pool.query<{ flare_tx_hash: string }>(
    `SELECT flare_tx_hash FROM withdrawals WHERE new_action_state = $1 LIMIT 1`,
    [actionState.toString()],
  );
  return rows[0]?.flare_tx_hash ?? null;
}

/** Same, for a token's lock chain. */
export async function lockTxFor(token: string, lockState: bigint): Promise<string | null> {
  const { rows } = await pool.query<{ flare_tx_hash: string }>(
    `SELECT flare_tx_hash FROM locks WHERE token = $1 AND new_lock_state = $2 LIMIT 1`,
    [token.toLowerCase(), lockState.toString()],
  );
  return rows[0]?.flare_tx_hash ?? null;
}

// -----------------------------------------------------------------------------
// The shared transfer chain
// -----------------------------------------------------------------------------

export type TransferRow = {
  chain_index: string;
  token: string;
  recipient: string;
  amount: string;
  previous_head: string;
  new_head: string;
  flare_tx_hash: string;
};

export async function recordTransfer(input: {
  index: bigint;
  token: string;
  recipient: string;
  amount: bigint;
  previousHead: bigint;
  newHead: bigint;
  flareTxHash: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO transfers
       (chain_index, token, recipient, amount, previous_head, new_head, flare_tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chain_index) DO NOTHING`,
    [
      input.index.toString(),
      input.token.toLowerCase(),
      input.recipient,
      input.amount.toString(),
      input.previousHead.toString(),
      input.newHead.toString(),
      input.flareTxHash,
    ],
  );
}

/**
 * The range a segment proof has to cover: everything from `from` up to and
 * including `to`, in chain order, whatever the asset.
 *
 * Foreign records are included deliberately — they are what the circuit steps
 * over, and leaving them out would produce a segment that does not meet.
 *
 * Returns null when either end is unknown, which means the indexer has not
 * caught up. Proving against a gap would fail on chain instead, after paying
 * for it.
 */
export async function transferRange(from: bigint, to: bigint): Promise<TransferRow[] | null> {
  const start = from === 0n ? 0n : await transferIndexOf(from);
  if (start === null) return null;
  const end = await transferIndexOf(to);
  if (end === null) return null;

  // `from` is a head, so the range starts at the record *after* it. Zero is the
  // empty chain, whose first record is index 0.
  const first = from === 0n ? 0n : start + 1n;
  if (first > end) return [];

  const { rows } = await pool.query<TransferRow>(
    `SELECT * FROM transfers WHERE chain_index >= $1 AND chain_index <= $2
      ORDER BY chain_index ASC`,
    [first.toString(), end.toString()],
  );
  // A hole would make the proof unbuildable; better to know here.
  return rows.length === Number(end - first + 1n) ? rows : null;
}

/** Position of the record that produced `head`, or null if it is not indexed. */
export async function transferIndexOf(head: bigint): Promise<bigint | null> {
  const { rows } = await pool.query<{ chain_index: string }>(
    `SELECT chain_index FROM transfers WHERE new_head = $1 LIMIT 1`,
    [head.toString()],
  );
  return rows[0] === undefined ? null : BigInt(rows[0].chain_index);
}

/** The transaction that produced `head` — what the FDC attestation is asked for. */
export async function transferTxFor(head: bigint): Promise<string | null> {
  const { rows } = await pool.query<{ flare_tx_hash: string }>(
    `SELECT flare_tx_hash FROM transfers WHERE new_head = $1 LIMIT 1`,
    [head.toString()],
  );
  return rows[0]?.flare_tx_hash ?? null;
}
