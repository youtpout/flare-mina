import { CONTRACTS, MINA } from '@/lib/config';

/**
 * Standing notice above the tabs.
 *
 * Not dismissible on purpose: someone landing after the fork should not be able
 * to hide the one line explaining why their old balance is gone, and then
 * conclude the bridge lost it.
 */
export function Notice() {
  return (
    <>
      {/* Which chain and which bridge this build actually talks to. Added after
          an afternoon of stale-bundle debugging: a wallet signs over the bridge
          address, so a page serving yesterday's constant produces a valid
          signature for the wrong contract and the chain rejects it with nothing
          more useful than InvalidMinaSignature. */}
      <div className="notice-bar" style={{ background: '#0f1620', borderColor: '#1f2635' }}>
        <span className="notice-dot" style={{ background: '#4ade80' }} aria-hidden="true" />
        <span className="mono" style={{ fontSize: 12.5 }}>
          Mina <strong style={{ color: '#e8ecf3' }}>{MINA.network}</strong>
          {' · bridge '}
          <strong style={{ color: '#e8ecf3' }}>{CONTRACTS.bridge}</strong>
        </span>
      </div>
      <div className="notice-bar">
        <span className="notice-dot" aria-hidden="true" />
        <span>
          <strong>Mina devnet upgraded to Mesa on 19 August.</strong> Flare{' '}
          <span className="grad">×</span> Mina now runs on o1js 3.0.0, and the wrapped-asset
          contracts have been <strong>redeployed at new addresses</strong> — a verification key
          cannot survive a protocol upgrade. Wrapped balances held before the fork stay on the old
          contracts; the escrow and its bridged MINA are unaffected.{' '}
          <a
            href="https://x.com/MinaProtocol/status/2085719449986814291"
            target="_blank"
            rel="noreferrer"
          >
            Mina&apos;s announcement
          </a>
        </span>
      </div>
    </>
  );
}
