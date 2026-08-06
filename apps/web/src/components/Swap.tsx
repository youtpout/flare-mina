import { useEffect, useMemo, useState } from 'react';
import { encodeFunctionData, formatUnits, parseUnits, type Hex } from 'viem';
import type { Session } from '@/App';
import { DEX, TOKENS, explorerTx } from '@/lib/config';
import type { Route } from '@/lib/flare';
import {
  accountAbi,
  erc20Abi,
  nextNonce,
  bestRoute,
  readBalances,
  routerAbi,
  submit,
  type Balance,
} from '@/lib/flare';
import { PURPOSE, batchHash, signAuthorization } from '@/lib/mina';

/** Slippage the user tolerates, in basis points. */
const SLIPPAGE_BPS = 500n;

/** Quotes go stale; a short deadline is what stops one being used much later. */
const DEADLINE_SECONDS = 600n;

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

export function Swap({ session }: { session: Session }) {
  const [fromSymbol, setFromSymbol] = useState('USD₮0');
  const [toSymbol, setToSymbol] = useState('FXRP');
  const [amount, setAmount] = useState('1');
  const [route, setRoute] = useState<Route | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Balance[] | null>(null);

  /**
   * Balances for the account being swapped from, refreshed after every swap.
   *
   * A quote says what the pool would give; it says nothing about whether the
   * account holds the input at all. Without this the first sign of an empty
   * balance is a revert, after the signature.
   */
  useEffect(() => {
    let live = true;
    readBalances(session.account)
      .then((b) => live && setBalances(b))
      .catch(() => live && setBalances(null));
    return () => {
      live = false;
    };
  }, [session.account, txHash]);

  const balanceOf = (symbol: string) =>
    balances?.find((b) => b.token.symbol === symbol) ?? null;

  const from = useMemo(() => TOKENS.find((t) => t.symbol === fromSymbol)!, [fromSymbol]);
  const to = useMemo(() => TOKENS.find((t) => t.symbol === toSymbol)!, [toSymbol]);

  const amountIn = useMemo(() => {
    try {
      return parseUnits(amount || '0', from.decimals);
    } catch {
      return 0n;
    }
  }, [amount, from.decimals]);

  useEffect(() => {
    let live = true;
    setRoute(null);
    if (amountIn === 0n || from.address === to.address) return;

    setQuoting(true);
    bestRoute(from.address, to.address, amountIn)
      .then((r) => live && setRoute(r))
      .finally(() => live && setQuoting(false));

    return () => {
      live = false;
    };
  }, [amountIn, from.address, to.address]);

  const out = route?.amountOut ?? null;

  /** Symbols along the route, so the user can see it is not always direct. */
  const hops =
    route === null
      ? null
      : route.path
          .map((a) => TOKENS.find((t) => t.address.toLowerCase() === a.toLowerCase())?.symbol ?? '?')
          .join(' → ');

  const minOut = out === null ? null : (out * (10_000n - SLIPPAGE_BPS)) / 10_000n;

  const fromBalance = balanceOf(fromSymbol);
  const insufficient = fromBalance !== null && amountIn > fromBalance.raw;

  /** Swap the two sides. The amount stays put: it is denominated in whatever
   *  sits on top, and re-quoting is cheap. */
  function flip() {
    setFromSymbol(toSymbol);
    setToSymbol(fromSymbol);
  }

  /** Unit price, which is what tells a user whether the quote is sane. */
  const rate =
    out === null || amountIn === 0n
      ? null
      : formatUnits((out * 10n ** BigInt(from.decimals)) / amountIn, to.decimals);

  async function doSwap() {
    setError(null);
    setTxHash(null);
    try {
      if (route === null || minOut === null) throw new Error('no quote available');

      setStatus('Building the batch…');
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_SECONDS;

      // approve then swap, in that order. Batching them means one signature and
      // one nonce, and no live approval sitting between two transactions.
      const calls = [
        {
          target: from.address,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [DEX.router, amountIn],
          }),
        },
        {
          target: DEX.router,
          value: 0n,
          data: encodeFunctionData({
            abi: routerAbi,
            functionName: 'swapExactTokensForTokens',
            // The routed path, not a direct pair: the two must be the same
            // path the quote was priced on, or minOut is against the wrong one.
            args: [amountIn, minOut, route.path, session.account, deadline],
          }),
        },
      ];

      const nonce = await nextNonce(session.x, session.isOdd);

      setStatus('Waiting for your Mina wallet…');
      const signature = await signAuthorization(session.provider, {
        purpose: PURPOSE.accountBatch,
        chainId: 114n,
        target: session.account,
        actionHash: batchHash(calls),
        nonce,
        expiry: BigInt('18446744073709551615'),
      });

      setStatus('Submitting…');
      const expiry = BigInt('18446744073709551615');

      // The relayer pays the gas. It cannot reorder the batch, drop a call,
      // add one, or retarget anything — the signature commits to the ordered
      // list and the account recomputes that commitment. Which is the point:
      // a Mina key authorises, and needs no EVM key to be acted on.
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
      const body = (await res.json()) as { flareTxHash?: string; error?: string };

      if (res.status === 501) {
        // No sponsor configured, so fall back to the user's own wallet.
        const data = encodeFunctionData({
          abi: accountAbi,
          functionName: 'executeBatch',
          args: [
            [session.x, session.isOdd, session.y],
            [BigInt(signature.field), BigInt(signature.scalar)],
            nonce,
            expiry,
            calls.map((c) => [c.target, c.value, c.data] as const),
          ],
        });
        setTxHash(await submit(session.account, data));
      } else if (!res.ok) {
        throw new Error(body.error ?? `relayer returned ${res.status}`);
      } else {
        setTxHash(body.flareTxHash as `0x${string}`);
      }
      setStatus('Swapped.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    }
  }

  return (
    <div className="swapwrap">
      <div className="panel">
        <h2>Swap</h2>

        <div className="swapstack">
          <div className="swapcard">
            <div className="swapcard-head">
              <span>You pay</span>
              <span>
                Balance {balances === null ? '…' : (fromBalance?.formatted ?? '0')}
                {fromBalance !== null && fromBalance.raw > 0n && (
                  <button
                    className="maxbtn"
                    onClick={() => setAmount(formatUnits(fromBalance.raw, from.decimals))}
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
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="0"
              />
              <select
                className="tokensel"
                value={fromSymbol}
                onChange={(e) => setFromSymbol(e.target.value)}
              >
                {TOKENS.map((t) => (
                  <option key={t.symbol}>{t.symbol}</option>
                ))}
              </select>
            </div>
          </div>

          <button className="flip" onClick={flip} title="Swap direction">
            ↓
          </button>

          <div className="swapcard">
            <div className="swapcard-head">
              <span>You receive</span>
              <span>
                Balance {balances === null ? '…' : (balanceOf(toSymbol)?.formatted ?? '0')}
              </span>
            </div>
            <div className="swapcard-body">
              {/* readOnly, not disabled: the pool's answer is not editable, but
                  it is the number the user came for and must not read as greyed
                  out. */}
              <input
                className="amount"
                value={quoting ? '…' : out === null ? '' : formatUnits(out, to.decimals)}
                placeholder="0"
                readOnly
              />
              <select
                className="tokensel"
                value={toSymbol}
                onChange={(e) => setToSymbol(e.target.value)}
              >
                {TOKENS.map((t) => (
                  <option key={t.symbol}>{t.symbol}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="details">
          <div className="row">
            <span className="muted small">Rate</span>
            <span className="mono">
              {rate === null ? '—' : `1 ${fromSymbol} ≈ ${rate} ${toSymbol}`}
            </span>
          </div>
          <div className="row">
            <span className="muted small">
              Minimum received · {Number(SLIPPAGE_BPS) / 100}% slippage
            </span>
            <span className="mono">{minOut === null ? '—' : formatUnits(minOut, to.decimals)}</span>
          </div>
          <div className="row">
            <span className="muted small">Route</span>
            <span className="small">{hops === null ? 'BlazeSwap' : `${hops} · BlazeSwap`}</span>
          </div>
        </div>

        <button
          className="primary"
          style={{ marginTop: 16, width: '100%' }}
          disabled={out === null || amountIn === 0n || insufficient}
          onClick={doSwap}
        >
          {insufficient ? `Not enough ${fromSymbol}` : 'Sign with Mina and swap'}
        </button>

        {status && <p className="status ok">{status}</p>}
        {error && <p className="status err">{error}</p>}
        {txHash && (
          <p className="status">
            <a href={explorerTx(txHash)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          </p>
        )}
      </div>

      <div className="notice">
        <strong>One signature covers both steps.</strong> An ERC-20 swap needs an approval and then
        the swap itself; signing them as one ordered batch means a single nonce and no approval left
        live between two transactions. The account has no idea what BlazeSwap is — it executes a
        signed list of calls, which is why any DEX works without an adapter.
      </div>
    </div>
  );
}
