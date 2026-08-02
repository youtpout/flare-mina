import { useEffect, useState } from 'react';
import type { Session } from '@/App';
import { readBalances, readNativeBalance, type Balance } from '@/lib/flare';
import { COSTON2, MINA, explorerAddress } from '@/lib/config';

const short = (s: string, head = 10, tail = 8) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

export function Portfolio({ session }: { session: Session }) {
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [native, setNative] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          it today. Deployment happens automatically the first time you send something out.
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
