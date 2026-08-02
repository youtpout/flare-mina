import { useEffect, useMemo, useState } from 'react';
import { encodeFunctionData, formatUnits, parseUnits, type Hex } from 'viem';
import type { Session } from '@/App';
import { DEX, TOKENS, explorerTx } from '@/lib/config';
import { accountAbi, erc20Abi, nextNonce, quote, routerAbi, submit } from '@/lib/flare';
import { PURPOSE, batchHash, signAuthorization } from '@/lib/mina';

/** Slippage the user tolerates, in basis points. */
const SLIPPAGE_BPS = 500n;

/** Quotes go stale; a short deadline is what stops one being used much later. */
const DEADLINE_SECONDS = 600n;

export function Swap({ session }: { session: Session }) {
  const [fromSymbol, setFromSymbol] = useState('USD₮0');
  const [toSymbol, setToSymbol] = useState('FXRP');
  const [amount, setAmount] = useState('1');
  const [out, setOut] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    setOut(null);
    if (amountIn === 0n || from.address === to.address) return;

    setQuoting(true);
    quote(from.address, to.address, amountIn)
      .then((q) => live && setOut(q))
      .finally(() => live && setQuoting(false));

    return () => {
      live = false;
    };
  }, [amountIn, from.address, to.address]);

  const minOut = out === null ? null : (out * (10_000n - SLIPPAGE_BPS)) / 10_000n;

  async function doSwap() {
    setError(null);
    setTxHash(null);
    try {
      if (out === null || minOut === null) throw new Error('no quote available');

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
            args: [amountIn, minOut, [from.address, to.address], session.account, deadline],
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
      const data = encodeFunctionData({
        abi: accountAbi,
        functionName: 'executeBatch',
        args: [
          [session.x, session.isOdd, session.y],
          [BigInt(signature.field), BigInt(signature.scalar)],
          nonce,
          BigInt('18446744073709551615'),
          calls.map((c) => [c.target, c.value, c.data] as const),
        ],
      });

      const hash = await submit(session.account, data);
      setTxHash(hash);
      setStatus('Swapped.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    }
  }

  return (
    <>
      <div className="panel">
        <h2>Swap</h2>

        <div className="grid2">
          <div className="field">
            <label>From</label>
            <select value={fromSymbol} onChange={(e) => setFromSymbol(e.target.value)}>
              {TOKENS.map((t) => (
                <option key={t.symbol}>{t.symbol}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>To</label>
            <select value={toSymbol} onChange={(e) => setToSymbol(e.target.value)}>
              {TOKENS.map((t) => (
                <option key={t.symbol}>{t.symbol}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label>Amount</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </div>

        <div className="row">
          <span className="muted small">Expected out</span>
          <span className="mono">
            {quoting ? '…' : out === null ? 'no route' : formatUnits(out, to.decimals)}
          </span>
        </div>
        <div className="row">
          <span className="muted small">Minimum received · {Number(SLIPPAGE_BPS) / 100}% slippage</span>
          <span className="mono">{minOut === null ? '—' : formatUnits(minOut, to.decimals)}</span>
        </div>
        <div className="row">
          <span className="muted small">Route</span>
          <span className="small">BlazeSwap</span>
        </div>

        <button
          className="primary"
          style={{ marginTop: 14 }}
          disabled={out === null || amountIn === 0n}
          onClick={doSwap}
        >
          Sign with Mina and swap
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
    </>
  );
}
