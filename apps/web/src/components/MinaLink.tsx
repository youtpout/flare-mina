import { MINA } from '@/lib/config';

/**
 * A Mina address or transaction, linked when the network has an explorer.
 *
 * Mesa does not have one yet. Interpolating an empty base gave `/account/B62…`,
 * a relative link that lands on the app's own 404 — worse than no link, because
 * it looks like the app is broken rather than like the network is young.
 */
export function MinaLink({
  kind,
  id,
  children,
}: {
  kind: 'account' | 'tx';
  id: string;
  children: React.ReactNode;
}) {
  if (!MINA.explorer) return <span className="mono">{children}</span>;
  return (
    <a className="mono" href={`${MINA.explorer}/${kind}/${id}`} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
