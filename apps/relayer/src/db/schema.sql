-- Attestor state.
--
-- Nothing here is authoritative: the escrow lives on Mina and the mint
-- authority lives in a Flare contract. This database only remembers what the
-- watcher has already seen, so a restart does not re-attest a deposit or lose
-- one. Dropping it costs a resync, not funds.

CREATE TABLE IF NOT EXISTS deposits (
  id                BIGSERIAL PRIMARY KEY,

  -- Idempotency key. A Mina transaction is attested at most once.
  mina_tx_hash      TEXT        NOT NULL UNIQUE,

  -- Depositor's Mina key, packed as x | isOdd << 255, hex.
  mina_sender       TEXT        NOT NULL,
  -- Flare recipient, read from the payment memo.
  recipient         TEXT        NOT NULL,
  amount_nanomina   NUMERIC(20) NOT NULL CHECK (amount_nanomina > 0),

  -- Per-sender sequence, mirroring the contract's replay protection.
  nonce             BIGINT      NOT NULL,

  mina_block_height BIGINT      NOT NULL,
  status            TEXT        NOT NULL
                    CHECK (status IN ('awaiting-confirmations','attested','claimed','failed')),
  -- Why a deposit is stuck, so the UI can say something better than "pending".
  reason            TEXT,

  -- The attestor's signature over the intent digest. Null until attested.
  attestation       TEXT,
  flare_tx_hash     TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One nonce per sender, enforced by the database rather than by hoping the
  -- watcher never runs twice.
  UNIQUE (mina_sender, nonce)
);

CREATE INDEX IF NOT EXISTS deposits_sender_idx ON deposits (mina_sender);
CREATE INDEX IF NOT EXISTS deposits_status_idx ON deposits (status);

-- Where the watcher got to, so a restart resumes instead of rescanning.
CREATE TABLE IF NOT EXISTS watermark (
  id            INT PRIMARY KEY CHECK (id = 1),
  last_height   BIGINT      NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO watermark (id, last_height) VALUES (1, 0) ON CONFLICT DO NOTHING;
