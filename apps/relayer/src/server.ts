import cors from 'cors';
import express from 'express';
import { depositsFor, migrate, pool } from './db/index.js';
import { startWatcher } from './watcher.js';

/**
 * Attestor API.
 *
 * Two responsibilities, deliberately separated: a watcher that observes Mina
 * and signs attestations, and a read-only HTTP surface the frontend polls.
 *
 * Nothing here can move funds. The attestation it produces is only half of what
 * a mint requires — the depositor's own Schnorr signature binds the recipient
 * and the amount, and the contract verifies it. If this service is down,
 * pending deposits wait; if it is compromised, it still cannot choose who gets
 * paid.
 */

const PORT = Number(process.env.PORT ?? 8787);

const app = express();

// The frontend is served from a different origin, and every route here is
// public read-only data, so a permissive policy costs nothing.
app.use(cors());
app.use(express.json({ limit: '32kb' }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    // Report the failure rather than a cheerful 200: a health check that lies
    // is worse than none.
    res.status(503).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** Deposits for one Mina key, packed as `x | isOdd << 255`. */
app.get('/deposits/:minaSender', async (req, res) => {
  const sender = req.params.minaSender;
  if (!/^0x[0-9a-fA-F]{64}$/.test(sender)) {
    return res.status(400).json({ error: 'minaSender must be a 32-byte hex string' });
  }

  try {
    const rows = await depositsFor(sender);
    res.json({
      deposits: rows.map((r) => ({
        id: r.id,
        status: r.status,
        amountNanomina: r.amount_nanomina,
        recipient: r.recipient,
        nonce: r.nonce,
        minaTxHash: r.mina_tx_hash,
        flareTxHash: r.flare_tx_hash,
        // The attestation is public: it is useless without the depositor's own
        // signature, so withholding it would only break self-service claiming.
        attestation: r.attestation,
        reason: r.reason,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

async function main() {
  await migrate();

  const watcher = startWatcher();

  const server = app.listen(PORT, () => {
    console.log(`attestor API listening on :${PORT}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    watcher.stop();
    server.close();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((e) => {
  console.error('failed to start:', e);
  process.exit(1);
});
