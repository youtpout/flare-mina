import { useEffect, useState } from 'react';
import type { Session } from '@/App';
import { readBalances, type Balance } from '@/lib/flare';
import { COSTON2, MINA, explorerAddress } from '@/lib/config';
import { SignaturePreview } from '@/components/SignaturePreview';

const short = (s: string, head = 10, tail = 8) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

export function Portfolio({
  session,
  onRefresh,
}: {
  session: Session;
  onRefresh: () => Promise<void>;
}) {
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  /**
   * Deploy the account.
   *
   * Permissionless: the address is `CREATE2(minaKey)`, so who sends this
   * transaction has no bearing on who controls the result. There is nothing to
   * sign — the relayer just pays the gas.
   */
  async function deploy() {
    setDeployError(null);
    setDeploying(true);
    try {
      const res = await fetch(`${API}/accounts/${session.packed}/deploy`, { method: 'POST' });
      const body = (await res.json()) as { flareTxHash?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `relayer returned ${res.status}`);
      // Re-read from the chain rather than assuming success flipped the flag,
      // and without reloading -- a reload would drop the session.
      await onRefresh();
    } catch (e) {
      setDeployError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeploying(false);
    }
  }

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // readBalances covers the native coin too, now that it is a listed token.
        const b = await readBalances(session.account);
        if (!live) return;
        setBalances(b);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [session.account]);

  return (
    <>
      <div className="panel">
        <h2>Accounts</h2>

        <div className="row">
          <span className="muted small">Mina wallet</span>
          <span className="mono">{short(session.minaAddress)}</span>
        </div>

        <div className="row">
          <span className="muted small">Flare account it owns</span>
          <a
            className="mono"
            href={explorerAddress(session.account)}
            target="_blank"
            rel="noreferrer"
          >
            {short(session.account)}
          </a>
        </div>

        <div className="row">
          <span className="muted small">Status</span>
          <span className={`tag ${session.deployed ? 'ok' : 'warn'}`}>
            {session.deployed ? 'deployed' : 'not deployed yet'}
          </span>
        </div>
      </div>

      {!session.deployed && (
        <div className="notice">
          <strong>This address already belongs to you.</strong> It is derived from your Mina public
          key with CREATE2, so it is fixed before any transaction exists — the bridge can pay into
          it today. Deploying is only needed before you send something out.
          <div style={{ marginTop: 12 }}>
            <button className="primary" disabled={deploying} onClick={deploy}>
              {deploying ? 'Deploying…' : 'Deploy now'}
            </button>
          </div>
          {deployError !== null && <p className="status err">{deployError}</p>}
        </div>
      )}

      <div className="panel" style={{ marginTop: 14 }}>
        <h2>Balances on {COSTON2.name}</h2>

        {error && <p className="status err">{error}</p>}
        {!balances && !error && <p className="muted small">Reading the chain…</p>}

        {balances && (
          <>
            {/* The native coin is in the token list now, so it needs no row of
                its own — it would be the same figure twice. */}
            {balances.map(({ token, formatted }) => (
              <div className="row" key={token.symbol}>
                <span>
                  {token.symbol}
                  {token.native === true && <span className="muted small"> native</span>}
                  {token.note && <span className="muted small"> · {token.note}</span>}
                </span>
                <span className="mono">{formatted}</span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="notice" style={{ marginTop: 14 }}>
        Gas is paid by whoever submits your transaction — anyone can, because your Mina signature
        commits to the target, the value and the calldata. A submitter cannot redirect anything, and
        gains nothing by trying. Deposits arrive from{' '}
        <a href={`${MINA.explorer}/account/${MINA.bridgeAccount}`} target="_blank" rel="noreferrer">
          the escrow account
        </a>{' '}
        on Mina {MINA.network}.
      </div>
          <SignaturePreview session={session} />

</>
  );
}
