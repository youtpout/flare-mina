import { useEffect, useState } from 'react';
import type { Session } from '@/App';
import { readBalances, readNativeBalance, type Balance } from '@/lib/flare';
import { COSTON2, MINA, explorerAddress } from '@/lib/config';

const short = (s: string, head = 10, tail = 8) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

export function Portfolio({ session }: { session: Session }) {
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [native, setNative] = useState<string | null>(null);
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
      // Reload so the derived state comes back from the chain rather than
      // being guessed at here.
      window.location.reload();
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
        const [b, n] = await Promise.all([
          readBalances(session.account),
          readNativeBalance(session.account),
        ]);
        if (!live) return;
        setBalances(b);
        setNative(n);
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
            <div className="row">
              <span>
                {COSTON2.nativeSymbol} <span className="muted small">native</span>
              </span>
              <span className="mono">{native ?? '—'}</span>
            </div>

            {balances.map(({ token, formatted }) => (
              <div className="row" key={token.symbol}>
                <span>
                  {token.symbol}
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
    </>
  );
}
