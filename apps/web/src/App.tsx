import { useCallback, useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import { decompressPublicKey, encodeMinaRecipient, parseMinaAddress } from '@minaport/shared';
import { getMinaProvider, type MinaProvider } from '@/lib/mina';
import { deriveAccount } from '@/lib/flare';
import { Portfolio } from '@/components/Portfolio';
import { Swap } from '@/components/Swap';
import { Bridge } from '@/components/Bridge';

export type Session = {
  provider: MinaProvider;
  /** Mina address, base58. */
  minaAddress: string;
  /** Curve point — the form the contracts work with. */
  x: bigint;
  /**
   * Recovered on the client. The Solidity verifier takes `y` as an argument
   * rather than deriving it, because a square root in the Pallas field would
   * cost more on-chain than the rest of the verification.
   */
  y: bigint;
  isOdd: boolean;
  /** `x | isOdd << 255`, the key the factory salts with. */
  packed: Hex;
  /** The Flare account this Mina key owns. */
  account: Address;
  deployed: boolean;
};

const TABS = ['portfolio', 'swap', 'bridge'] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>('portfolio');
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [hasWallet, setHasWallet] = useState(true);

  useEffect(() => {
    // Wallets inject asynchronously; checking once on mount misses slow ones.
    const check = () => setHasWallet(getMinaProvider() !== null);
    check();
    const timer = setTimeout(check, 700);
    return () => clearTimeout(timer);
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const provider = getMinaProvider();
      if (!provider) throw new Error('No Mina wallet found. Install Auro or Pallad.');

      const [minaAddress] = await provider.requestAccounts();
      if (!minaAddress) throw new Error('Wallet returned no account');

      // Decompress to the curve point, then pack it the way the contracts do.
      const parts = parseMinaAddress(minaAddress);
      const point = decompressPublicKey(parts);
      const packed = encodeMinaRecipient(parts);
      const { address, deployed } = await deriveAccount(packed);

      setSession({
        provider,
        minaAddress,
        x: point.x,
        y: point.y,
        isOdd: parts.isOdd,
        packed,
        account: address,
        deployed,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  return (
    <>
      <h1>
        Flare <span className="grad">x</span> Mina
      </h1>
      <p className="sub">
        Your Mina wallet holds and trades assets on Flare. It never needs an EVM key.
      </p>

      {!session ? (
        <div className="panel">
          <h2>Connect your Mina wallet</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            A Mina key is a Pallas key — it cannot sign EVM transactions, so it owns a contract
            account instead. That account&apos;s address is derived from your public key and exists
            before anything is deployed, so connecting is enough to see it.
          </p>
          <button className="primary" onClick={connect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
          {!hasWallet && (
            <p className="status err">
              No Mina wallet detected. Install{' '}
              <a href="https://aurowallet.com" target="_blank" rel="noreferrer">
                Auro
              </a>{' '}
              or{' '}
              <a href="https://pallad.co" target="_blank" rel="noreferrer">
                Pallad
              </a>
              .
            </p>
          )}
          {error && <p className="status err">{error}</p>}
        </div>
      ) : (
        <>
          <div className="tabs">
            {TABS.map((t) => (
              <button key={t} className="tab" data-active={tab === t} onClick={() => setTab(t)}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {tab === 'portfolio' && <Portfolio session={session} />}
          {tab === 'swap' && <Swap session={session} />}
          {tab === 'bridge' && <Bridge session={session} />}
        </>
      )}
    </>
  );
}
