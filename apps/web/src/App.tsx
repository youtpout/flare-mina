import { useCallback, useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import { decompressPublicKey, encodeMinaRecipient, parseMinaAddress } from '@minaport/shared';
import { getMinaProvider, type MinaProvider } from '@/lib/mina';
import { deriveAccount } from '@/lib/flare';
import { Portfolio } from '@/components/Portfolio';
import { Swap } from '@/components/Swap';
import { Bridge } from '@/components/Bridge';
import { Network } from '@/components/Network';

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

const TABS = ['portfolio', 'swap', 'bridge', 'network'] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>('portfolio');
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [hasWallet, setHasWallet] = useState(true);
  const [showNetwork, setShowNetwork] = useState(false);

  useEffect(() => {
    // Wallets inject asynchronously; checking once on mount misses slow ones.
    const check = () => setHasWallet(getMinaProvider() !== null);
    check();
    const timer = setTimeout(check, 700);
    return () => clearTimeout(timer);
  }, []);

  /**
   * Build a session from a Mina address.
   *
   * Everything the app shows hangs off this key: the Flare account is
   * `CREATE2(packed)`, the deposit list is keyed by it, and the swap panel
   * spends its balances. So switching accounts means rebuilding all of it, not
   * patching the address in place.
   */
  const sessionFor = useCallback(
    async (provider: MinaProvider, minaAddress: string): Promise<Session> => {
      // Decompress to the curve point, then pack it the way the contracts do.
      const parts = parseMinaAddress(minaAddress);
      const point = decompressPublicKey(parts);
      const packed = encodeMinaRecipient(parts);
      const { address, deployed } = await deriveAccount(packed);

      return {
        provider,
        minaAddress,
        x: point.x,
        y: point.y,
        isOdd: parts.isOdd,
        packed,
        account: address,
        deployed,
      };
    },
    [],
  );

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const provider = getMinaProvider();
      if (!provider) throw new Error('No Mina wallet found. Install Auro or Pallad.');

      const [minaAddress] = await provider.requestAccounts();
      if (!minaAddress) throw new Error('Wallet returned no account');

      setSession(await sessionFor(provider, minaAddress));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, [sessionFor]);

  /**
   * Restore the session on load when the wallet has already authorised us.
   *
   * `getAccounts` returns what is already granted without prompting, unlike
   * `requestAccounts`. Without this, every refresh looks like a disconnect --
   * which it is not, the permission is still there -- and any code that
   * reloads the page throws the user back to the connect screen.
   */
  useEffect(() => {
    if (session !== null) return;
    const provider = getMinaProvider();
    if (provider?.getAccounts === undefined) return;

    let live = true;
    void provider
      .getAccounts()
      .then(async (accounts) => {
        const first = accounts[0];
        if (!live || first === undefined) return;
        setSession(await sessionFor(provider, first));
      })
      .catch(() => undefined); // Not yet authorised is the normal case, not an error.

    return () => {
      live = false;
    };
  }, [hasWallet, session, sessionFor]);

  /**
   * Follow the wallet when the user switches accounts.
   *
   * Without this the app keeps showing the previous key's Flare account,
   * deposits and balances while the wallet signs as someone else — and a
   * signature produced by the new key would be checked against the old one's
   * derived address, so the transaction fails for a reason the screen does not
   * explain. Silently wrong is the worst of the three possible behaviours.
   *
   * An empty list means the wallet locked or revoked this site: drop the
   * session rather than leave a stale one on screen.
   */
  useEffect(() => {
    const provider = session?.provider ?? getMinaProvider();
    if (provider?.on === undefined) return;

    const onAccountsChanged = (accounts: string[]) => {
      const next = accounts[0];
      if (next === undefined) {
        setSession(null);
        return;
      }
      // Re-deriving is cheap and the wallet is the authority, so do it on every
      // event rather than trying to detect whether the key really changed.
      void sessionFor(provider, next)
        .then((built) => {
          setSession(built);
          setError(null);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    };

    provider.on('accountsChanged', onAccountsChanged);
    return () => provider.removeListener?.('accountsChanged', onAccountsChanged);
  }, [session?.provider, sessionFor]);

  /** Re-derive the session from the chain, e.g. after the account is deployed. */
  const refresh = useCallback(async () => {
    if (session === null) return;
    setSession(await sessionFor(session.provider, session.minaAddress));
  }, [session, sessionFor]);

  return (
    <>
      <h1>
        Flare <span className="grad">x</span> Mina
      </h1>
      <p className="sub">
        Your Mina wallet holds and trades assets on Flare. It never needs an EVM key.
      </p>

      {!session ? (
        <>
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

          {/* The setup a fresh wallet needs before the faucets above are of any
              use. Shown whether or not a wallet is detected: an installed wallet
              left on Mainnet fails as "account not found", which reads like a
              bug rather than a wrong network. */}
          <div className="notice" style={{ marginTop: 18 }}>
            <strong>Starting from scratch?</strong>
            <p className="small" style={{ marginBottom: 0 }}>
              Install{' '}
              <a href="https://aurowallet.com" target="_blank" rel="noreferrer">
                Auro
              </a>{' '}
              or{' '}
              <a href="https://pallad.co" target="_blank" rel="noreferrer">
                Pallad
              </a>
              , then switch it to <strong>Devnet</strong> — it starts on Mainnet.
            </p>
            <p className="muted small" style={{ marginBottom: 0 }}>
              The Flare faucet wants the address your Mina key owns, which appears once you
              connect — nothing needs to be deployed first.
            </p>
          </div>

          {/* Visible without a wallet on purpose: the bridge's state is public,
              and someone evaluating it should not have to install an extension
              to see whether it is running. */}
          <p className="small" style={{ marginTop: 18 }}>
            <button className="tab" style={{ padding: 0 }} onClick={() => setShowNetwork((v) => !v)}>
              {showNetwork ? 'Hide network status' : 'Or look at the network status →'}
            </button>
          </p>
        </div>
        {showNetwork && <Network />}
        </>
      ) : (
        <>
          <div className="tabs">
            {TABS.map((t) => (
              <button key={t} className="tab" data-active={tab === t} onClick={() => setTab(t)}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {tab === 'portfolio' && <Portfolio session={session} onRefresh={refresh} />}
          {tab === 'swap' && <Swap session={session} />}
          {tab === 'bridge' && <Bridge session={session} />}
          {tab === 'network' && <Network />}
        </>
      )}
    </>
  );
}
