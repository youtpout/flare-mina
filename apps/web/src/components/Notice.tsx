import { CONTRACTS, MINA } from '@/lib/config';

/**
 * Standing notice above the tabs.
 *
 * Not dismissible on purpose: someone landing mid-outage should not be able to
 * hide the one line that explains why nothing settles, and then conclude the
 * bridge is broken.
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
        <strong>Mina devnet upgrades on 19 August</strong> and will be down for part of
        the day — deposits and releases will not settle while it is. Flare{' '}
        <span className="grad">×</span> Mina follows on <strong>20 August</strong>.{' '}
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
