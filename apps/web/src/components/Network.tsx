import { useCallback, useEffect, useState } from 'react';
import { COSTON2, MINA, explorerAddress, explorerTx } from '@/lib/config';
import { readJson } from '@/lib/api';

/**
 * What the bridge is actually doing.
 *
 * A balance tells you nothing about why a transfer is stuck. This tab shows the
 * machinery instead: the two cursors that have to meet, the Flare validator set
 * whose signatures move them, and the transactions on both chains. When a
 * withdrawal sits at "waiting for FDC", this is the page that says whether the
 * relayer is behind or the validator set simply has not signed yet.
 */

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

/** Poll, rather than pushing. Both chains move in minutes, not seconds. */
const REFRESH_MS = 20_000;

/** Rows per page in the activity feed. */
const PAGE_SIZE = 10;

type Snapshot = {
  flare: {
    bridge: string;
    vault: string | null;
    withdrawalActionState: string;
    escrowedNanomina: string | null;
    currentMinaActionState: string | null;
  } | null;
  mina: {
    address: string;
    balance: string | null;
    signingPolicyRoot: string;
    flareActionState: string;
    processedActionState: string;
    requiredWeight: string;
  } | null;
  policy: {
    relay: string;
    blockNumber: string;
    rewardEpochId: number | null;
    fdcProtocolId: number;
    knownValidatorKeys: number;
  } | null;
  activity: {
    kind: 'deposit' | 'withdrawal' | 'lock';
    status: string;
    /** In the asset's own base units — not nanomina for a lock. */
    amount: string;
    asset: string;
    decimals: number;
    counterparty: string;
    flareTxHash: string | null;
    minaTxHash: string | null;
    at: string;
  }[];
  inSync: boolean | null;
};

/** Chain states are 77-digit field elements. Nobody reads those; they compare them. */
function shortField(value: string | null | undefined): string {
  if (!value) return '—';
  if (value === '0') return '0 (empty chain)';
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function nanomina(value: string | null): string {
  if (value === null) return '—';
  return `${(Number(value) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 })} MINA`;
}

/** Bridged decimals are never converted, so each asset is quoted in its own. */
function amount(value: string, decimals: number, asset: string): string {
  const scaled = Number(value) / 10 ** decimals;
  return `${scaled.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${asset}`;
}

function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export function Network() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/network`);
      if (!res.ok) throw new Error(`relayer returned ${res.status}`);
      setSnapshot((await readJson(res)) as Snapshot);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (error !== null && snapshot === null) {
    return (
      <div className="panel">
        <div className="notice">
          <strong>The relayer is unreachable.</strong> {error}
          <div className="small muted" style={{ marginTop: 6 }}>
            Both chains keep running without it — it holds no funds and its only job is
            carrying signatures across.
          </div>
        </div>
      </div>
    );
  }

  if (snapshot === null) return <div className="panel muted small">Loading…</div>;

  const { flare, mina, policy, activity, inSync } = snapshot;
  const pageCount = Math.max(1, Math.ceil(activity.length / PAGE_SIZE));
  // A refresh can shorten the feed under a page the user is standing on.
  const current = Math.min(page, pageCount - 1);
  if (current !== page) setPage(current);

  return (
    <>
      <div className="panel">
        <h2>Chain state</h2>
        <p className="small muted" style={{ margin: '-8px 0 14px' }}>
          Every burn on Flare folds into a Poseidon chain. Mina releases against a head the
          Flare validator set signed, so these two values meeting is what makes a withdrawal
          claimable.
        </p>

        <div className="row">
          <span className="small muted">Flare withdrawal chain</span>
          <span className="mono">{shortField(flare?.withdrawalActionState)}</span>
        </div>
        <div className="row">
          <span className="small muted">Attested on Mina</span>
          <span className="mono">{shortField(mina?.flareActionState)}</span>
        </div>
        <div className="row">
          <span className="small muted">Released up to</span>
          <span className="mono">{shortField(mina?.processedActionState)}</span>
        </div>
        <div className="row">
          <span className="small muted">Status</span>
          <span className={`tag ${inSync === true ? 'ok' : 'warn'}`}>
            {inSync === null
              ? 'unknown'
              : inSync
                ? 'in sync'
                : 'publication due'}
          </span>
        </div>
      </div>

      <div className="panel">
        <h2>Flare validator set</h2>
        <p className="small muted" style={{ margin: '-8px 0 14px' }}>
          The FDC finalises a round roughly a minute after it closes, and the same validators
          sign it. The relayer recovers their public keys from those signatures — below the
          threshold it refuses to publish rather than publishing something weaker.
        </p>

        <div className="row">
          <span className="small muted">Relay contract</span>
          <a className="mono" href={explorerAddress(policy?.relay ?? '')} target="_blank" rel="noreferrer">
            {policy?.relay ? shortHash(policy.relay) : '—'}
          </a>
        </div>
        <div className="row">
          <span className="small muted">Reward epoch</span>
          <span className="mono">
            {policy?.rewardEpochId ?? '—'}
            <span className="muted"> · rotates every 6h</span>
          </span>
        </div>
        <div className="row">
          <span className="small muted">FDC protocol id</span>
          <span className="mono">{policy?.fdcProtocolId ?? '—'}</span>
        </div>
        <div className="row">
          <span className="small muted">Validator keys recovered</span>
          <span className="mono">{policy?.knownValidatorKeys ?? '—'}</span>
        </div>
        <div className="row">
          <span className="small muted">Required signing weight</span>
          <span className="mono">{mina?.requiredWeight ?? '—'}</span>
        </div>
        <div className="row">
          <span className="small muted">Signing policy root</span>
          <span className="mono">{shortField(mina?.signingPolicyRoot)}</span>
        </div>
        <div className="row">
          <span className="small muted">Coston2 block</span>
          <span className="mono">{policy?.blockNumber ?? '—'}</span>
        </div>
      </div>

      <div className="panel">
        <h2>Contracts</h2>
        <div className="row">
          <span className="small muted">Bridge ({COSTON2.nativeSymbol} side)</span>
          <a className="mono" href={explorerAddress(flare?.bridge ?? '')} target="_blank" rel="noreferrer">
            {flare?.bridge ? shortHash(flare.bridge) : '—'}
          </a>
        </div>
        {flare?.vault && (
          <div className="row">
            <span className="small muted">Asset vault</span>
            <a className="mono" href={explorerAddress(flare.vault)} target="_blank" rel="noreferrer">
              {shortHash(flare.vault)}
            </a>
          </div>
        )}
        <div className="row">
          <span className="small muted">Escrow (Mina)</span>
          <a
            className="mono"
            href={`${MINA.explorer}/account/${mina?.address ?? MINA.bridgeAccount}`}
            target="_blank"
            rel="noreferrer"
          >
            {(mina?.address ?? MINA.bridgeAccount).slice(0, 12)}…
          </a>
        </div>
        <div className="row">
          <span className="small muted">Escrowed on Mina</span>
          <span className="mono">{nanomina(mina?.balance ?? null)}</span>
        </div>
        <div className="row">
          <span className="small muted">Backing FMINA on Flare</span>
          <span className="mono">{nanomina(flare?.escrowedNanomina ?? null)}</span>
        </div>
      </div>

      <div className="panel">
        <h2>Recent bridge transactions</h2>
        {activity.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>
            Nothing has crossed yet. Every rail appears here — MINA both ways, and each
            bridged asset — with the transaction on each chain.
          </p>
        ) : (
          activity.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE).map((row, i) => (
            <div className="row" key={`${row.kind}-${row.flareTxHash ?? row.minaTxHash ?? i}`}>
              <span className="small">
                <span className="tag" style={{ marginRight: 8 }}>
                  {row.kind === 'deposit' ? 'Mina → Flare' : 'Flare → Mina'}
                </span>
                {amount(row.amount, row.decimals, row.asset)}
                <span className="muted"> · {row.status}</span>
              </span>
              <span className="small" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                {row.minaTxHash && (
                  <a className="mono" href={`${MINA.explorer}/tx/${row.minaTxHash}`} target="_blank" rel="noreferrer">
                    Mina
                  </a>
                )}
                {row.flareTxHash && (
                  <a className="mono" href={explorerTx(row.flareTxHash)} target="_blank" rel="noreferrer">
                    Flare
                  </a>
                )}
                <span className="muted">{ago(row.at)}</span>
              </span>
            </div>
          ))
        )}

        {pageCount > 1 && (
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <span className="small muted" style={{ marginRight: 'auto' }}>
              {current * PAGE_SIZE + 1}–{Math.min((current + 1) * PAGE_SIZE, activity.length)} of{' '}
              {activity.length}
            </span>
            <button
              className="ghost"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={current === 0}
            >
              Previous
            </button>
            <button
              className="ghost"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={current >= pageCount - 1}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </>
  );
}
