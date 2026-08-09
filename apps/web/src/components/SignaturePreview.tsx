import { useState } from 'react';
import { keccak256, toHex, type Hex } from 'viem';
import type { Session } from '@/App';
import { COSTON2 } from '@/lib/config';
import { PURPOSE, authorizationFields, authorizationMessage } from '@/lib/mina';

/**
 * What the two signing styles look like in the wallet, side by side.
 *
 * A preview, not a code path: nothing here authorises anything. It exists to
 * answer with a screenshot whether a readable message is worth ~300k extra gas
 * per verification, which is what moving from Kimchi Poseidon to the legacy one
 * costs — see `PoseidonLegacy.sol`.
 */
export function SignaturePreview({ session }: { session: Session }) {
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  // A plausible authorization: this account calling itself, nothing to execute.
  // The digest is what a real call would commit to; the values are what the
  // contract would recompute.
  const params = {
    purpose: PURPOSE.accountCall,
    chainId: BigInt(COSTON2.id),
    target: session.account as Hex,
    actionHash: keccak256(toHex('preview')),
    nonce: 0n,
    expiry: 1893456000n,
  };

  const message = authorizationMessage(params);
  const fields = authorizationFields(params);

  async function sign(kind: 'message' | 'fields') {
    setError(null);
    setSignature(null);
    setSigning(true);
    try {
      if (kind === 'message') {
        if (session.provider.signMessage === undefined) {
          throw new Error('this wallet does not expose signMessage');
        }
        const result = await session.provider.signMessage({ message });
        setSignature(JSON.stringify(result.signature));
      } else {
        const result = await session.provider.signFields({ message: fields });
        setSignature(JSON.stringify(result.signature));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigning(false);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <h2>What your wallet shows you</h2>
      <p className="muted small">
        Both authorise the same thing. The first is a string the wallet can render; the second is
        the field encoding used today, which Auro draws as a column of decimals. Signing here
        authorises nothing — it is a preview.
      </p>

      <p className="muted small" style={{ marginTop: 14 }}>
        As a readable message
      </p>
      <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>
        {message}
      </pre>
      <button className="primary" disabled={signing} onClick={() => void sign('message')}>
        Sign as a message
      </button>

      <p className="muted small" style={{ marginTop: 18 }}>
        As fields, what the bridge signs today
      </p>
      <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>
        {fields.join('\n')}
      </pre>
      <button disabled={signing} onClick={() => void sign('fields')}>
        Sign as fields
      </button>

      {signature !== null && (
        <p className="status" style={{ wordBreak: 'break-all' }}>
          signed: {signature}
        </p>
      )}
      {error !== null && <p className="status err">{error}</p>}
    </div>
  );
}
