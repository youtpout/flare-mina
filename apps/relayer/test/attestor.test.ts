import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  DEPOSIT_INTENT_DOMAIN,
  evaluate,
  intentDigest,
  recipientFromMemo,
  type AttestorPolicy,
  type MinaPayment,
} from '../src/attestor.js';

const BRIDGE = 'B62qq2k9am4nVrsqUSZ1EjUok4awJyuKpzE5bEvZqHUiVo2gYtNJMAY';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

const POLICY: AttestorPolicy = {
  bridgeAddress: BRIDGE,
  confirmations: 15,
  minAmountNanomina: 1_000_000n,
  maxAmountNanomina: 1_000_000_000_000n,
};

function payment(over: Partial<MinaPayment> = {}): MinaPayment {
  return {
    hash: 'CkpZ...',
    from: 'B62qsender',
    to: BRIDGE,
    amountNanomina: 5_000_000_000n,
    memo: RECIPIENT,
    blockHeight: 100,
    ...over,
  };
}

const SENDER_PACKED = `0x${'11'.repeat(32)}` as const;

describe('memo parsing', () => {
  it('accepts both the prefixed and bare forms a wallet might write', () => {
    expect(recipientFromMemo(RECIPIENT)).toBe(RECIPIENT);
    expect(recipientFromMemo(RECIPIENT.slice(2))).toBe(RECIPIENT);
    expect(recipientFromMemo(`  ${RECIPIENT}  `)).toBe(RECIPIENT);
  });

  it('refuses anything it cannot read, rather than guessing', () => {
    // A misparse here mints to the wrong account, so absence beats a guess.
    for (const bad of ['', 'hello', '0x123', RECIPIENT + 'ff', '0xZZZZ']) {
      expect(recipientFromMemo(bad), bad).toBeNull();
    }
  });
});

describe('attestation policy', () => {
  it('attests a well-formed, confirmed deposit', () => {
    const d = evaluate(payment(), 200, POLICY, SENDER_PACKED, 0n);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.target.recipient).toBe(RECIPIENT);
      expect(d.target.amountNanomina).toBe(5_000_000_000n);
    }
  });

  it('waits for confirmations', () => {
    const d = evaluate(payment({ blockHeight: 195 }), 200, POLICY, SENDER_PACKED, 0n);
    expect(d).toMatchObject({ ok: false });
    if (!d.ok) expect(d.reason).toMatch(/confirmations/);
  });

  it('ignores payments to other accounts', () => {
    const d = evaluate(payment({ to: 'B62qsomeoneelse' }), 200, POLICY, SENDER_PACKED, 0n);
    expect(d).toMatchObject({ ok: false });
  });

  /// A per-deposit ceiling bounds what one signature is worth if the watcher is
  /// ever fooled. This key can mint, so the cap is not paranoia.
  it('refuses deposits above the ceiling', () => {
    const d = evaluate(
      payment({ amountNanomina: POLICY.maxAmountNanomina + 1n }),
      200,
      POLICY,
      SENDER_PACKED,
      0n,
    );
    expect(d).toMatchObject({ ok: false });
    if (!d.ok) expect(d.reason).toMatch(/ceiling/);
  });

  it('refuses a deposit whose memo names no address', () => {
    const d = evaluate(payment({ memo: 'thanks!' }), 200, POLICY, SENDER_PACKED, 0n);
    expect(d).toMatchObject({ ok: false });
    if (!d.ok) expect(d.reason).toMatch(/memo/);
  });
});

describe('intent digest', () => {
  /// The contract recomputes this digest from its own arguments. A mismatch is
  /// not a subtle bug — it is a deposit nobody can ever claim — so it is checked
  /// against Solidity's own encoder rather than against a copy of our own logic.
  it('matches the Solidity encoding byte for byte', () => {
    const target = {
      minaSender: SENDER_PACKED,
      recipient: RECIPIENT as `0x${string}`,
      amountNanomina: 5_000_000_000n,
      nonce: 3n,
    };

    const solidity = execFileSync(
      'cast',
      [
        'keccak',
        execFileSync(
          'cast',
          [
            'abi-encode',
            'f(bytes32,uint256,bytes32,address,uint64,uint64)',
            DEPOSIT_INTENT_DOMAIN,
            '114',
            target.minaSender,
            target.recipient,
            target.amountNanomina.toString(),
            target.nonce.toString(),
          ],
          { encoding: 'utf8', env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' } },
        ).trim(),
      ],
      { encoding: 'utf8', env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' } },
    ).trim();

    expect(intentDigest(114n, target)).toBe(solidity);
  });
});
