import { useEffect, useState } from 'react';
import type { Session } from '@/App';
import { MINA, explorerTx } from '@/lib/config';

/**
 * Deposit status, as the API reports it.
 *
 * A deposit needs two authorisations. The user's signature binds the recipient
 * and the amount; the attestor confirms the escrow landed on Mina. Neither party
 * can produce the mint alone, so the UI has to show which half is outstanding
 * rather than a single opaque spinner.
 */
type DepositStatus =
  | 'awaiting-payment'
  | 'awaiting-confirmations'
  | 'attested'
  | 'claimed'
  | 'failed';

type Deposit = {
  id: string;
  status: DepositStatus;
  amountNanomina: string;
  minaTxHash: string | null;
  flareTxHash: string | null;
  reason: string | null;
};

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

const LABEL: Record<DepositStatus, string> = {
  'awaiting-payment': 'Waiting for your MINA payment',
  'awaiting-confirmations': 'Payment seen, waiting for confirmations',
  attested: 'Attested — ready to claim',
  claimed: 'Claimed',
  failed: 'Failed',
};

export function Bridge({ session }: { session: Session }) {
  const [deposits, setDeposits] = useState<Deposit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <>
      <div className="panel">
        <h2>Mina → Flare</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Send MINA to the escrow account with your Flare address in the memo. It is an ordinary
          payment — any Mina wallet can make it, and you generate no proof.
        </p>

        <div className="field">
          <label>1 · Send to this account on Mina {MINA.network}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input readOnly value={MINA.bridgeAccount} className="mono" />
            <button className="ghost" onClick={() => copy(MINA.bridgeAccount)}>
              {copied ? '✓' : 'Copy'}
            </button>
          </div>
        </div>

        <div className="field">
          <label>2 · Put this in the memo — it is where the FMINA goes</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input readOnly value={session.account} className="mono" />
            <button className="ghost" onClick={() => copy(session.account)}>
              Copy
            </button>
          </div>
        </div>

        <div className="notice">
          The memo is how the attestor learns your destination — it reads it from the chain it is
          already watching, so there is nothing to register beforehand. A Mina memo holds 32 bytes
          and an address is 20, so it fits with room to spare.
        </div>
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
              {d.flareTxHash && (
                <a className="small" href={explorerTx(d.flareTxHash)} target="_blank" rel="noreferrer">
                  tx
                </a>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="panel">
        <h2>Flare → Mina</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Burning FMINA emits a canonical withdrawal event that the Mina side releases against.
        </p>
        <div className="notice">
          <strong>Not live yet.</strong> This direction is the one being built without a trusted
          party: Flare publishes Merkle roots signed by a weighted validator set, so proving a Flare
          event on Mina is signature verification — measured at 31,810 constraints per signature —
          rather than verifying a recursive proof. That is why the return path gets the real
          machinery and the inbound path does not.
        </div>
      </div>
    </>
  );
}
