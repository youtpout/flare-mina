-- Attestor state.
--
-- Nothing here is authoritative: the escrow lives on Mina and the mint
-- authority lives in a Flare contract, so this database cannot cause a loss of
-- funds. What it can cause is a *delay*: a deposit whose row is gone still sits
-- escrowed and correctly accounted on Mina, but nobody can attest to it until
-- the depositor re-supplies its details. See docs/threat-model.md — an archive
-- node is what would make that recoverable without the depositor.

CREATE TABLE IF NOT EXISTS deposits (
  id                BIGSERIAL PRIMARY KEY,

  -- Set once the wallet has broadcast. Null between building and submission,
  -- because the hash does not exist until the transaction is signed.
  mina_tx_hash      TEXT        UNIQUE,

  -- Depositor's Mina key, packed as x | isOdd << 255, hex.
  mina_sender       TEXT        NOT NULL,
  -- Flare recipient. Bound inside the proof, not read from a memo.
  recipient         TEXT        NOT NULL,
  amount_nanomina   NUMERIC(20) NOT NULL CHECK (amount_nanomina > 0),

  -- Caller-chosen, and only has to make the deposit unique: the Flare side
  -- keys `consumedIntents` on (sender, recipient, amount, nonce).
  nonce             BIGINT      NOT NULL,

  -- Null until the deposit is seen on chain.
  mina_block_height BIGINT,

  status            TEXT        NOT NULL
                    CHECK (status IN ('built','submitted','attested','claimed','failed')),
  -- Why a deposit is stuck, so the UI can say something better than "pending".
  reason            TEXT,

  -- The attestor's signature over the intent digest. Null until attested.
  attestation       TEXT,
  flare_tx_hash     TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The contract does not police nonce reuse — it cannot, without serialising
  -- every depositor — so the uniqueness the Flare side depends on is enforced
  -- here, where it costs nothing.
  UNIQUE (mina_sender, nonce)
);

CREATE INDEX IF NOT EXISTS deposits_sender_idx ON deposits (mina_sender);
CREATE INDEX IF NOT EXISTS deposits_status_idx ON deposits (status);

-- Migration from the memo/payment-watching schema, where a row only ever
-- existed once a payment had been seen. Idempotent: each step is a no-op on a
-- database already in the new shape.
ALTER TABLE deposits ALTER COLUMN mina_tx_hash DROP NOT NULL;
ALTER TABLE deposits ALTER COLUMN mina_block_height DROP NOT NULL;
ALTER TABLE deposits DROP CONSTRAINT IF EXISTS deposits_status_check;
-- 'aborted' is not 'failed': nothing went wrong, the row simply belongs to a
-- deployment that no longer exists, or to a proof the wallet never signed.
-- Keeping the two apart matters — 'failed' is worth investigating and this is
-- not, and a UI that says "Failed" about a superseded deployment is lying.
ALTER TABLE deposits ADD CONSTRAINT deposits_status_check
  CHECK (status IN ('built','submitted','attested','claimed','failed','aborted'));

-- The Flare -> Mina return path.
--
-- A burn on Flare is the authorisation and it has already happened by the time
-- a row appears here: the user's FMINA is gone, and the event carries the
-- recipient and the amount. This table only tracks which burns have been
-- honoured on the Mina side.
CREATE TABLE IF NOT EXISTS withdrawals (
  id                BIGSERIAL PRIMARY KEY,

  -- Assigned by the bridge contract and strictly increasing. The zkApp
  -- requires releases in this order, so it is both the identity and the queue.
  nonce             NUMERIC(78) NOT NULL UNIQUE,

  -- Mina account, base58, decoded from the packed form in the event.
  recipient         TEXT        NOT NULL,
  amount_nanomina   NUMERIC(20) NOT NULL CHECK (amount_nanomina > 0),

  flare_tx_hash     TEXT        NOT NULL,
  mina_tx_hash      TEXT,

  status            TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','released','failed')),
  reason            TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS withdrawals_status_idx ON withdrawals (status);

-- Flare's validator public keys.
--
-- The signing policy publishes addresses, and an address is a hash — the key
-- itself is only knowable once that validator has signed something, recovered
-- from the signature. Harvesting it again on every restart would make coverage
-- depend on whatever happens to be in the lookback window; stored, it only ever
-- grows.
--
-- Keyed by address rather than policy index: Coston2 reshuffles the order every
-- reward epoch (6h) while keeping the same signers, so an index is valid for
-- one epoch and an address is valid forever.
--
-- Not authoritative. Every key is re-checked against the address the policy
-- lists before it is used, so a wrong row can only cause a proof to be skipped.
CREATE TABLE IF NOT EXISTS validator_keys (
  -- Lowercase signing-policy address.
  address     TEXT        PRIMARY KEY,
  -- Uncompressed secp256k1 point, 0x04 || x(32) || y(32).
  public_key  TEXT        NOT NULL,

  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);
