import { installResilientFetch } from './resilientFetch.js';

// Bounds the public Mina endpoint's intermittent 60s stalls. Must run before
// anything fetches — o1js included.
installResilientFetch();

import cors from 'cors';
import express from 'express';
import { encodeMinaRecipient, parseMinaAddress } from '@minaport/shared';
import {
  depositsFor,
  markClaimed,
  markSubmitted,
  migrate,
  nextNonceFor,
  pool,
  recordBuilt,
} from './db/index.js';
import { buildDeposit } from './prover/index.js';
import { submitClaim, submitterConfigured } from './submitter.js';
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

/**
 * Build and prove a deposit. Returns an **unsigned** transaction.
 *
 * The relayer proves because a zkApp method call is a proof and o1js has to run
 * somewhere; it costs no trust because `deposit` pulls funds through
 * `AccountUpdate.createSigned(sender)`. Nothing moves until the depositor's
 * wallet signs that exact account update, and the client checks the recipient
 * and amount in the returned JSON before it does.
 *
 * The row is written before the transaction can possibly land, which is what
 * lets the service restart mid-flight without losing track of a deposit.
 */
app.post('/deposits/build', async (req, res) => {
  const { sender, recipient, amountNanomina } = req.body ?? {};

  if (typeof sender !== 'string' || !sender.startsWith('B62')) {
    return res.status(400).json({ error: 'sender must be a Mina address' });
  }
  if (typeof recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    return res.status(400).json({ error: 'recipient must be a Flare address' });
  }
  let amount: bigint;
  try {
    amount = BigInt(amountNanomina);
  } catch {
    return res.status(400).json({ error: 'amountNanomina must be an integer' });
  }
  if (amount <= 0n) return res.status(400).json({ error: 'amountNanomina must be positive' });

  try {
    const packed = encodeMinaRecipient(parseMinaAddress(sender));
    const nonce = await nextNonceFor(packed);

    const row = await recordBuilt({
      minaSender: packed,
      recipient,
      amountNanomina: amount,
      nonce,
    });

    const built = await buildDeposit({ sender, recipient: recipient as `0x${string}`, amountNanomina: amount, nonce });

    res.json({
      id: row.id,
      nonce: nonce.toString(),
      transaction: built.transaction,
      provingMs: built.provingMs,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** The wallet has broadcast; from here the poller waits for inclusion. */
app.post('/deposits/:id/submitted', async (req, res) => {
  const { minaTxHash } = req.body ?? {};
  if (typeof minaTxHash !== 'string' || minaTxHash.length === 0) {
    return res.status(400).json({ error: 'minaTxHash is required' });
  }

  try {
    await markSubmitted(req.params.id, minaTxHash);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Submit a claim to Flare, paying the gas.
 *
 * The caller supplies their own Schnorr signature; the bridge recomputes the
 * recipient, amount, nonce and expiry from it before minting. This service
 * therefore cannot redirect a mint, resize it, or replay it — see
 * `submitter.ts`. Paying the gas is a favour, not an authorisation, which is
 * what lets a Mina user claim without holding an EVM key at all.
 */
app.post('/deposits/:id/claim', async (req, res) => {
  if (!submitterConfigured()) {
    return res.status(501).json({ error: 'no submitter configured; submit from your own wallet' });
  }

  const { publicKey, signature, recipient, amountNanomina, nonce, expiry, attestation } =
    req.body ?? {};

  try {
    const hash = await submitClaim({
      publicKey: { x: BigInt(publicKey.x), isOdd: Boolean(publicKey.isOdd), y: BigInt(publicKey.y) },
      signature: { field: BigInt(signature.field), scalar: BigInt(signature.scalar) },
      recipient,
      amountNanomina: BigInt(amountNanomina),
      nonce: BigInt(nonce),
      expiry: BigInt(expiry),
      attestation,
    });

    await markClaimed(req.params.id, hash);
    res.json({ flareTxHash: hash });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * The claim landed on Flare.
 *
 * Cosmetic on purpose: the mint already happened, and `consumedIntents` on the
 * bridge is what actually prevents a second one. This only stops the UI from
 * offering a Claim button for something already claimed.
 */
app.post('/deposits/:id/claimed', async (req, res) => {
  const { flareTxHash } = req.body ?? {};
  if (typeof flareTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(flareTxHash)) {
    return res.status(400).json({ error: 'flareTxHash must be a 32-byte hex string' });
  }

  try {
    await markClaimed(req.params.id, flareTxHash);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
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
