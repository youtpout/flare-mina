/**
 * Standing notice above the tabs.
 *
 * Not dismissible on purpose: someone landing mid-outage should not be able to
 * hide the one line that explains why nothing settles, and then conclude the
 * bridge is broken.
 */
export function Notice() {
  return (
    <div className="notice-bar">
      <span className="notice-dot" aria-hidden="true" />
      <span>
        <strong>Mina devnet upgrades on 19 August</strong> and is unavailable that day —
        deposits and releases will not settle. Flare <span className="grad">×</span> Mina
        follows on <strong>20 August</strong>.{' '}
        <a
          href="https://x.com/MinaProtocol/status/2085719449986814291"
          target="_blank"
          rel="noreferrer"
        >
          Mina&apos;s announcement
        </a>
      </span>
    </div>
  );
}
