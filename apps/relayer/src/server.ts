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
  locksFor,
  markReleaseSettled,
  markReleaseSubmitted,
  nextReleaseNonceFor,
  pool,
  recordBuilt,
  recordRelease,
  releasesFor,
  withdrawalsFor,
} from './db/index.js';
import { buildBurn, buildDeposit } from './prover/index.js';
import {
  deployAccount,
  submitBatch,
  submitClaim,
  submitRelease,
  submitterConfigured,
} from './submitter.js';
import { networkSnapshot } from './network.js';
import { startWatcher } from './watcher.js';
import { startTransfers } from './transfers.js';
import { startWithdrawals } from './withdrawals.js';
import { assets, startAssets } from './assets.js';
import { startReleases } from './releases.js';

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

const MINA_GRAPHQL =
  process.env.MINA_GRAPHQL ?? 'https://mina-devnet-graphql.aurowallet.com/graphql';

/**
 * A holder's balance of one wrapped asset.
 *
 * Keyed by token id: a token balance lives in its own account, so asking for
 * the plain account returns their MINA instead — silently, and wrong.
 */
async function tokenBalance(publicKey: string, tokenId?: string): Promise<bigint | null> {
  if (tokenId === undefined) return null;
  try {
    const res = await fetch(MINA_GRAPHQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ account(publicKey: "${publicKey}", token: "${tokenId}") { balance { total } } }`,
      }),
    });
    const body = (await res.json()) as {
      data?: { account?: { balance?: { total?: string } } };
    };
    const total = body.data?.account?.balance?.total;
    return total === undefined ? null : BigInt(total);
  } catch {
    return null;
  }
}

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

/**
 * Build an unsigned burn of a wrapped asset, the first step of the return leg.
 *
 * The holder's balance is read now and stored: a burn is confirmed later by
 * that balance having fallen, which is what keeps this off an archive node.
 */
app.post('/releases/build', async (req, res) => {
  const { sender, token, recipient, amount } = req.body ?? {};

  if (typeof sender !== 'string' || !sender.startsWith('B62')) {
    return res.status(400).json({ error: 'sender must be a Mina address' });
  }
  if (typeof recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    return res.status(400).json({ error: 'recipient must be a Flare address' });
  }
  const asset = assets().find((a) => a.flareToken.toLowerCase() === String(token).toLowerCase());
  if (asset === undefined) return res.status(400).json({ error: 'unknown token' });

  let value: bigint;
  try {
    value = BigInt(amount);
  } catch {
    return res.status(400).json({ error: 'amount must be an integer' });
  }
  if (value <= 0n) return res.status(400).json({ error: 'amount must be positive' });

  try {
    const packed = encodeMinaRecipient(parseMinaAddress(sender));
    const nonce = await nextReleaseNonceFor(packed);
    const balanceBefore = await tokenBalance(sender, asset.tokenId);
    if (balanceBefore === null) {
      return res.status(400).json({ error: `no ${asset.symbol} account for ${sender}` });
    }
    if (balanceBefore < value) {
      return res.status(400).json({ error: `balance is ${balanceBefore}, cannot burn ${value}` });
    }

    const row = await recordRelease({
      minaSender: packed,
      token: asset.flareToken,
      recipient,
      amount: value,
      nonce,
      balanceBefore,
    });

    const built = await buildBurn({ sender, token: asset.token, amount: value });

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

/** The wallet has broadcast the burn; the poller confirms it from here. */
app.post('/releases/:id/submitted', async (req, res) => {
  const { minaTxHash } = req.body ?? {};
  if (typeof minaTxHash !== 'string' || minaTxHash.length === 0) {
    return res.status(400).json({ error: 'minaTxHash is required' });
  }
  try {
    await markReleaseSubmitted(req.params.id, minaTxHash);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Take an attested release back to Flare, paying the gas.
 *
 * The same bargain as a deposit claim: the vault recomputes the token,
 * recipient, amount, nonce and expiry from the holder's Schnorr signature, so
 * this cannot redirect or resize anything. It is what lets a Mina user take
 * their assets back without holding an EVM key.
 */
app.post('/releases/:id/claim', async (req, res) => {
  if (!submitterConfigured()) {
    return res.status(501).json({ error: 'no submitter configured; claim from your own wallet' });
  }

  const { publicKey, signature, token, recipient, amount, nonce, expiry, attestation } =
    req.body ?? {};
  try {
    const hash = await submitRelease({
      publicKey: {
        x: BigInt(publicKey.x),
        isOdd: Boolean(publicKey.isOdd),
        y: BigInt(publicKey.y),
      },
      signature: { field: BigInt(signature.field), scalar: BigInt(signature.scalar) },
      token,
      recipient,
      amount: BigInt(amount),
      nonce: BigInt(nonce),
      expiry: BigInt(expiry),
      attestation,
    });
    await markReleaseSettled(req.params.id, hash);
    res.json({ flareTxHash: hash });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/releases/:recipient', async (req, res) => {
  try {
    res.json({ releases: await releasesFor(req.params.recipient) });
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
 * Execute a signed batch on a `MinaAccount`, paying the gas.
 *
 * The signature commits to the ordered calls, and the account recomputes that
 * commitment, so this service cannot reorder, drop, add or retarget anything.
 * It is the same bargain as a claim: gas in exchange for nothing.
 */
app.post('/accounts/execute', async (req, res) => {
  if (!submitterConfigured()) {
    return res.status(501).json({ error: 'no submitter configured; submit from your own wallet' });
  }

  const { account, publicKey, signature, nonce, expiry, calls } = req.body ?? {};
  try {
    const hash = await submitBatch({
      account,
      publicKey: { x: BigInt(publicKey.x), isOdd: Boolean(publicKey.isOdd), y: BigInt(publicKey.y) },
      signature: { field: BigInt(signature.field), scalar: BigInt(signature.scalar) },
      nonce: BigInt(nonce),
      expiry: BigInt(expiry),
      calls: (calls as { target: string; value: string; data: string }[]).map((c) => ({
        target: c.target as `0x${string}`,
        value: BigInt(c.value),
        data: c.data as `0x${string}`,
      })),
    });
    res.json({ flareTxHash: hash });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Deploy the caller's `MinaAccount`, paying the gas.
 *
 * Permissionless by design — the address is `CREATE2(minaKey)`, so who sends
 * the transaction has no bearing on who controls the account. This route
 * therefore takes no signature and grants nothing; it spends gas on the user's
 * behalf and nothing else.
 */
app.post('/accounts/:minaKey/deploy', async (req, res) => {
  const minaKey = req.params.minaKey;
  if (!/^0x[0-9a-fA-F]{64}$/.test(minaKey)) {
    return res.status(400).json({ error: 'minaKey must be a 32-byte hex string' });
  }
  if (!submitterConfigured()) {
    return res.status(501).json({ error: 'no submitter configured; deploy from your own wallet' });
  }

  try {
    res.json({ flareTxHash: await deployAccount(minaKey as `0x${string}`) });
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
        // Ordering the merged transfer list needs a timestamp on both rails.
        createdAt: r.created_at,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * The machinery, for the Network tab: both chains' cursors, the live signing
 * policy, and a global activity feed. Read-only and cheap enough to poll.
 */
app.get('/network', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 60) || 60, 200);
  try {
    res.json(await networkSnapshot(limit));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Assets locked on Flare and headed for one Mina account, base58.
 *
 * Separate from `/withdrawals` because they are separate rails: a withdrawal
 * releases MINA the escrow already holds, a lock mints a new wrapped token
 * against collateral in the vault. Merging them would need one status vocabulary
 * for two different machines.
 */
app.get('/locks/:recipient', async (req, res) => {
  try {
    const rows = await locksFor(req.params.recipient);
    res.json({
      locks: rows.map((r) => ({
        token: r.token,
        claimId: r.claim_id,
        amount: r.amount,
        status: r.status,
        flareTxHash: r.flare_tx_hash,
        minaTxHash: r.mina_tx_hash,
        reason: r.reason,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Withdrawals headed for one Mina account, base58. */
app.get('/withdrawals/:recipient', async (req, res) => {
  try {
    const rows = await withdrawalsFor(req.params.recipient);
    res.json({
      withdrawals: rows.map((r) => ({
        nonce: r.nonce,
        amountNanomina: r.amount_nanomina,
        status: r.status,
        flareTxHash: r.flare_tx_hash,
        minaTxHash: r.mina_tx_hash,
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
  // Before withdrawals: a release cannot land ahead of the state it proves against.
  const publisher = startTransfers();
  const withdrawals = startWithdrawals();
  // The asset rail. Silently inert unless FLARE_ASSET_VAULT_ADDRESS and
  // MINA_ASSET_PORTS are both set, so a MINA-only deployment pays nothing.
  const assetRail = startAssets();
  const releases = startReleases();

  const server = app.listen(PORT, () => {
    console.log(`attestor API listening on :${PORT}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    watcher.stop();
    publisher.stop();
    withdrawals.stop();
    assetRail.stop();
    releases.stop();
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
