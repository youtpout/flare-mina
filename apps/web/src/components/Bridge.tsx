import { useEffect, useState } from 'react';
import { encodeFunctionData, type Hex } from 'viem';
import type { Session } from '@/App';
import { CONTRACTS, MINA, explorerTx } from '@/lib/config';
import { bridgeAbi, erc20Abi, nextNonce, readBalances, submit, type Balance } from '@/lib/flare';
import {
  PURPOSE,
  batchHash,
  depositActionHash,
  depositCommitment,
  signAuthorization,
} from '@/lib/mina';

/**
 * Deposit status, as the API reports it.
 *
 * A deposit needs two authorisations. The user's signature binds the recipient
 * and the amount; the attestor confirms the escrow landed on Mina. Neither party
 * can produce the mint alone, so the UI has to show which half is outstanding
 * rather than a single opaque spinner.
 */
type DepositStatus = 'built' | 'submitted' | 'attested' | 'claimed' | 'failed' | 'aborted';

type Deposit = {
  id: string;
  status: DepositStatus;
  amountNanomina: string;
  recipient: string;
  nonce: string;
  minaTxHash: string | null;
  flareTxHash: string | null;
  /** The attestor's half. Useless on its own — the depositor still has to sign. */
  attestation: string | null;
  reason: string | null;
};

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

/**
 * Held back from MAX on a deposit. The escrow transaction itself costs a fee,
 * so offering the whole balance produces a transaction the wallet cannot send.
 */
const MINA_FEE_BUFFER = 200_000_000n; // 0.2 MINA

/**
 * What each stage is waiting on.
 *
 * "pending" used to cover three different waits — the state not yet published,
 * the release proof not yet built, the Mina block not yet mined — so a user
 * watching a stuck withdrawal had no way to tell which.
 */
const WITHDRAWAL_STAGE: Record<string, { tag: string; detail: string }> = {
  seen: {
    tag: 'waiting for FDC',
    detail: 'the burn is on Flare; its chain state reaches Mina at the next publication',
  },
  published: {
    tag: 'proving',
    detail: 'Mina accepted a state covering this burn — building the release proof',
  },
  releasing: { tag: 'releasing', detail: 'release sent, waiting for a Mina block' },
  released: { tag: 'released', detail: 'MINA delivered to your wallet' },
  failed: { tag: 'failed', detail: 'the release did not go through' },
};

const LABEL: Record<DepositStatus, string> = {
  // The row is written before the proof exists, so the relayer can pick a
  // deposit back up if it restarts mid-flight. This label therefore covers two
  // phases — the relayer still proving, and the proof waiting to be signed —
  // and must not claim the first one is over.
  built: 'Preparing — your wallet will ask you to sign',
  submitted: 'Broadcast — waiting for inclusion on Mina',
  attested: 'Attested — ready to claim',
  claimed: 'Claimed',
  failed: 'Failed',
  aborted: 'Superseded — from an earlier deployment',
};

export function Bridge({ session }: { session: Session }) {
  const [deposits, setDeposits] = useState<Deposit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [direction, setDirection] = useState<'toFlare' | 'toMina'>('toFlare');
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [depositing, setDepositing] = useState<string | null>(null);
  const [depositError, setDepositError] = useState<string | null>(null);
  const [burnAmount, setBurnAmount] = useState('');
  const [burning, setBurning] = useState<string | null>(null);
  const [burnError, setBurnError] = useState<string | null>(null);
  /** FMINA held on Flare — what a withdrawal spends. */
  const [flareBalances, setFlareBalances] = useState<Balance[] | null>(null);
  /** Native MINA held on devnet — what a deposit escrows. */
  const [minaBalance, setMinaBalance] = useState<bigint | null>(null);
  const [withdrawals, setWithdrawals] = useState<
    { nonce: string; amountNanomina: string; status: string }[] | null
  >(null);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const res = await fetch(`${API}/deposits/${session.packed}`);
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const body = (await res.json()) as { deposits: Deposit[] };
        if (live) {
          setDeposits(body.deposits);
          setError(null);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void poll();
    const timer = setInterval(poll, 8000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [session.packed]);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const res = await fetch(`${API}/withdrawals/${session.minaAddress}`);
        if (!res.ok) return;
        const body = (await res.json()) as { withdrawals: typeof withdrawals };
        if (live) setWithdrawals(body.withdrawals);
      } catch {
        // The deposit poll already surfaces an unreachable API.
      }
    };
    void poll();
    const timer = setInterval(poll, 8000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [session.minaAddress]);

  /**
   * Balances for both sides, refreshed whenever a transfer completes.
   *
   * Neither form could tell the user whether they hold the thing they are about
   * to send: a deposit with no MINA fails in the wallet, and a burn with no
   * FMINA reverts on Flare. Both only after a signature.
   */
  useEffect(() => {
    let live = true;
    readBalances(session.account)
      .then((b) => live && setFlareBalances(b))
      .catch(() => live && setFlareBalances(null));
    return () => {
      live = false;
    };
  }, [session.account, deposits, withdrawals]);

  useEffect(() => {
    let live = true;
    fetch(MINA.graphql, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ account(publicKey: "${session.minaAddress}") { balance { total } } }`,
      }),
    })
      .then((r) => r.json())
      .then((body: { data?: { account?: { balance?: { total?: string } } } }) => {
        const total = body.data?.account?.balance?.total;
        // The node reports MINA, not nanomina, and as a decimal string.
        if (live) setMinaBalance(total === undefined ? null : BigInt(Math.round(Number(total) * 1e9)));
      })
      .catch(() => live && setMinaBalance(null));
    return () => {
      live = false;
    };
  }, [session.minaAddress, deposits]);

  /**
   * Claim an attested deposit.
   *
   * This is the depositor's half of the 2-of-2. The attestor has already said
   * the escrow exists; this signature says where the FMINA goes and how much.
   * Neither is sufficient alone, which is why the attestor cannot pay itself.
   */
  async function claim(d: Deposit) {
    setClaimError(null);
    setClaiming(d.id);
    try {
      if (!d.attestation) throw new Error('not attested yet');

      const amount = BigInt(d.amountNanomina);
      const recipient = d.recipient as `0x${string}`;
      const nonce = BigInt(d.nonce);
      const expiry = BigInt('18446744073709551615');

      const signature = await signAuthorization(session.provider, {
        purpose: PURPOSE.depositIntent,
        chainId: 114n,
        target: CONTRACTS.bridge,
        actionHash: depositActionHash(recipient, amount),
        nonce,
        expiry,
      });

      // Hand the signature to the relayer, which pays the gas. It cannot
      // redirect or resize the mint — the bridge recomputes recipient, amount,
      // nonce and expiry from this signature before minting — so submitting is
      // a favour, not an authorisation. This is what lets a Mina user claim
      // without holding an EVM key.
      const res = await fetch(`${API}/deposits/${d.id}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publicKey: { x: session.x.toString(), isOdd: session.isOdd, y: session.y.toString() },
          signature: { field: signature.field, scalar: signature.scalar },
          recipient,
          amountNanomina: amount.toString(),
          nonce: nonce.toString(),
          expiry: expiry.toString(),
          attestation: d.attestation,
        }),
      });
      const body = (await res.json()) as { flareTxHash?: string; error?: string };

      if (res.status === 501) {
        // No relayer to pay for it, so fall back to the user's own wallet.
        const data = encodeFunctionData({
          abi: bridgeAbi,
          functionName: 'claimWithMinaSignature',
          args: [
            [session.x, session.isOdd, session.y],
            [BigInt(signature.field), BigInt(signature.scalar)],
            recipient,
            amount,
            nonce,
            expiry,
            d.attestation as Hex,
          ],
        });
        const flareTxHash = await submit(CONTRACTS.bridge, data);
        await fetch(`${API}/deposits/${d.id}/claimed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ flareTxHash }),
        }).catch(() => undefined);
      } else if (!res.ok) {
        throw new Error(body.error ?? `relayer returned ${res.status}`);
      }
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : String(e));
    } finally {
      setClaiming(null);
    }
  }

  /** MINA as typed, in nanomina. Null when it is not a usable number. */
  /** Nine decimals, the unit both sides account in. */
  const formatNano = (v: bigint) =>
    (Number(v) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 });

  const fmina = flareBalances?.find((b) => b.token.symbol === 'FMINA') ?? null;
  const wanted = nanomina(amount);
  const burnWanted = nanomina(burnAmount);

  // Balances are advisory until they load: refusing on `null` would block the
  // form whenever the node is slow, which is worse than letting the wallet say
  // no a moment later.
  const notEnoughMina =
    minaBalance !== null && wanted !== null && wanted + MINA_FEE_BUFFER > minaBalance;
  const notEnoughFmina = fmina !== null && burnWanted !== null && burnWanted > fmina.raw;

  function nanomina(input: string): bigint | null {
    if (!/^\d+(\.\d{1,9})?$/.test(input.trim())) return null;
    const [whole, fraction = ''] = input.trim().split('.');
    const value = BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
    return value > 0n ? value : null;
  }

  /**
   * Build, check, sign, broadcast.
   *
   * The check in the middle is the point: the relayer produced the proof, so
   * this reads the escrowed amount back out of the transaction it returned and
   * refuses to hand it to the wallet if it disagrees with what was asked for.
   * The recipient needs no such check — it is bound by the Schnorr signature at
   * claim time, which only the user can produce.
   */
  async function startDeposit() {
    const value = nanomina(amount);
    if (value === null) return;

    setDepositError(null);
    setDepositing('Building the proof…');
    try {
      const res = await fetch(`${API}/deposits/build`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: session.minaAddress,
          recipient: session.account,
          amountNanomina: value.toString(),
        }),
      });
      const built = (await res.json()) as {
        id: string;
        transaction: string;
        provingMs: number;
        error?: string;
      };
      if (!res.ok) throw new Error(built.error ?? `relayer returned ${res.status}`);

      const commitment = depositCommitment(built.transaction);
      if (commitment === null) throw new Error('could not read the built transaction');
      if (commitment.escrowedNanomina !== value) {
        throw new Error(
          `the built transaction escrows ${commitment.escrowedNanomina} nanomina, not ${value} — refusing to sign`,
        );
      }

      setDepositing('Waiting for your wallet…');
      const { hash } = await session.provider.sendTransaction({ transaction: built.transaction });

      await fetch(`${API}/deposits/${built.id}/submitted`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ minaTxHash: hash }),
      });

      setAmount('');
    } catch (e) {
      setDepositError(e instanceof Error ? e.message : String(e));
    } finally {
      setDepositing(null);
    }
  }

  /**
   * Burn FMINA and let the escrow release the MINA.
   *
   * One signed batch: approve the bridge, then burn. Atomic, so an approval
   * cannot survive a failed burn — and submitted by the relayer, because the
   * Mina key authorises but cannot pay for gas.
   *
   * Nothing else is signed afterwards. The burn *is* the authorisation: the
   * FMINA is gone, and the event carries the recipient and the amount.
   */
  async function burn() {
    const value = nanomina(burnAmount);
    if (value === null) return;

    setBurnError(null);
    setBurning('Waiting for your Mina wallet…');
    try {
      const nonce = await nextNonce(session.x, session.isOdd);
      const expiry = BigInt('18446744073709551615');

      const calls = [
        {
          target: CONTRACTS.fmina,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [CONTRACTS.bridge, value],
          }),
        },
        {
          target: CONTRACTS.bridge,
          value: 0n,
          data: encodeFunctionData({
            abi: bridgeAbi,
            functionName: 'burnToMina',
            args: [value, session.packed],
          }),
        },
      ];

      const signature = await signAuthorization(session.provider, {
        purpose: PURPOSE.accountBatch,
        chainId: 114n,
        target: session.account,
        actionHash: batchHash(calls),
        nonce,
        expiry,
      });

      setBurning('Submitting…');
      const res = await fetch(`${API}/accounts/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          account: session.account,
          publicKey: { x: session.x.toString(), isOdd: session.isOdd, y: session.y.toString() },
          signature: { field: signature.field, scalar: signature.scalar },
          nonce: nonce.toString(),
          expiry: expiry.toString(),
          calls: calls.map((c) => ({
            target: c.target,
            value: c.value.toString(),
            data: c.data,
          })),
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `relayer returned ${res.status}`);

      setBurnAmount('');
    } catch (e) {
      setBurnError(e instanceof Error ? e.message : String(e));
    } finally {
      setBurning(null);
    }
  }

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <>
      {/* The two directions are separate flows with separate state — one waits
          on a Mina inclusion, the other on a Flare event — so they get separate
          tabs rather than a scroll that mixes both. */}
      <div className="tabs">
        {(['toFlare', 'toMina'] as const).map((d) => (
          <button
            key={d}
            className="tab"
            data-active={direction === d}
            onClick={() => setDirection(d)}
          >
            {d === 'toFlare' ? 'Mina → Flare' : 'Flare → Mina'}
          </button>
        ))}
      </div>

      {direction === 'toFlare' && (
      <>
      <div className="panel">
        <h2>Mina → Flare</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Escrow MINA on {MINA.network} and receive FMINA on Flare. The proof is built for you —
          your wallet only signs.
        </p>

        <div className="swapcard" style={{ marginBottom: 14 }}>
          <div className="swapcard-head">
            <span>You escrow</span>
            <span>
              Balance {minaBalance === null ? '…' : formatNano(minaBalance)}
              {minaBalance !== null && minaBalance > 0n && (
                <button
                  className="maxbtn"
                  // A fee has to be left behind, or the wallet cannot broadcast
                  // the very transaction that escrows the rest.
                  onClick={() =>
                    setAmount(
                      formatNano(minaBalance > MINA_FEE_BUFFER ? minaBalance - MINA_FEE_BUFFER : 0n),
                    )
                  }
                >
                  MAX
                </button>
              )}
            </span>
          </div>
          <div className="swapcard-body">
            <input
              className="amount"
              value={amount}
              inputMode="decimal"
              placeholder="0"
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className="tokenfixed">MINA</span>
          </div>
        </div>

        <div className="field">
          <label>Goes to your Flare account</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input readOnly value={session.account} className="mono" />
            <button className="ghost" onClick={() => copy(session.account)}>
              {copied ? '✓' : 'Copy'}
            </button>
          </div>
        </div>

        <button
          className="primary"
          style={{ marginTop: 14 }}
          disabled={depositing !== null || nanomina(amount) === null || notEnoughMina}
          onClick={startDeposit}
        >
          {notEnoughMina ? 'Not enough MINA' : (depositing ?? 'Deposit')}
        </button>
        {depositError !== null && <p className="status err">{depositError}</p>}
      </div>

      <div className="panel">
        <h2>Your deposits</h2>

        {error && (
          <p className="status err">
            Cannot reach the attestor API ({error}). Deposits already on-chain are unaffected — the
            escrow does not depend on this service being up.
          </p>
        )}

        {!deposits && !error && <p className="muted small">Loading…</p>}
        {deposits?.length === 0 && (
          <p className="muted small">Nothing yet. Send a payment above and it will appear here.</p>
        )}

        {claimError && <p className="status err">{claimError}</p>}

        {deposits?.map((d) => (
          <div className="row" key={d.id}>
            <span>
              <span className="mono">{(Number(d.amountNanomina) / 1e9).toFixed(4)} MINA</span>
              {d.reason && <span className="muted small"> · {d.reason}</span>}
            </span>
            <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span className={`tag ${d.status === 'claimed' ? 'ok' : d.status === 'failed' ? 'warn' : ''}`}>
                {LABEL[d.status]}
              </span>
              {d.status === 'attested' && (
                <button className="ghost" disabled={claiming === d.id} onClick={() => claim(d)}>
                  {claiming === d.id ? 'Signing…' : 'Claim'}
                </button>
              )}
              {d.flareTxHash && (
                <a className="small" href={explorerTx(d.flareTxHash)} target="_blank" rel="noreferrer">
                  tx
                </a>
              )}
            </span>
          </div>
        ))}
      </div>
      </>
      )}

      {direction === 'toMina' && (
      <>
      <div className="panel">
        <h2>Flare → Mina</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Burn FMINA and the escrow releases the same amount of MINA to your wallet. The burn is
          the authorisation — there is nothing else to sign.
        </p>

        <div className="swapcard" style={{ marginBottom: 14 }}>
          <div className="swapcard-head">
            <span>You burn</span>
            <span>
              Balance {fmina === null ? '…' : fmina.formatted}
              {fmina !== null && fmina.raw > 0n && (
                <button className="maxbtn" onClick={() => setBurnAmount(formatNano(fmina.raw))}>
                  MAX
                </button>
              )}
            </span>
          </div>
          <div className="swapcard-body">
            <input
              className="amount"
              value={burnAmount}
              inputMode="decimal"
              placeholder="0"
              onChange={(e) => setBurnAmount(e.target.value)}
            />
            <span className="tokenfixed">FMINA</span>
          </div>
        </div>

        <div className="field">
          <label>Goes to your Mina account</label>
          <input readOnly value={session.minaAddress} className="mono" />
        </div>

        <button
          className="primary"
          style={{ marginTop: 14 }}
          disabled={burning !== null || nanomina(burnAmount) === null || notEnoughFmina}
          onClick={burn}
        >
          {notEnoughFmina ? 'Not enough FMINA' : (burning ?? 'Withdraw')}
        </button>
        {burnError !== null && <p className="status err">{burnError}</p>}

        <div className="notice">
          <strong>The relayer cannot invent a withdrawal.</strong> Each release carries a proof
          that the rest of Flare's withdrawal chain runs from this exact record to the state the
          escrow has accepted, so recipient, amount and order are all inside a hash it would have
          to find a collision for. What is still trusted is one step upstream — who publishes that
          state — and only once per batch rather than once per withdrawal.
        </div>
      </div>

      {/* Its own panel, with an empty state: rendering nothing when the list is
          empty leaves no way to tell "none yet" from "the API is down". */}
      <div className="panel">
        <h2>Your withdrawals</h2>

        {withdrawals === null && <p className="muted small">Reading…</p>}

        {withdrawals !== null && withdrawals.length === 0 && (
          <p className="muted small">
            Nothing yet. A burn appears here once the relayer has seen the event on Flare.
          </p>
        )}

        {withdrawals !== null &&
          withdrawals.map((w) => (
            <div className="row" key={w.nonce}>
              <span>
                <span className="mono small">{Number(w.amountNanomina) / 1e9} MINA</span>
                <span className="muted small">
                  {' · '}
                  {WITHDRAWAL_STAGE[w.status]?.detail ?? w.status}
                </span>
              </span>
              <span
                className={`tag ${
                  w.status === 'released' ? 'ok' : w.status === 'failed' ? 'warn' : ''
                }`}
              >
                {WITHDRAWAL_STAGE[w.status]?.tag ?? w.status}
              </span>
            </div>
          ))}
      </div>
      </>
      )}
    </>
  );
}
