import { beforeAll, describe, expect, it } from 'vitest';
import { Bool, Field, PublicKey, UInt64 } from 'o1js';
import { LockChain, LockRecord, applyLock } from '../src/LockChain.js';
import { applyWithdrawal, WithdrawalRecord } from '../src/WithdrawalChain.js';

/**
 * Replaying the lock chain `AssetVault` builds, one per bridged asset.
 *
 * Run with `proofsEnabled: false`, so these exercise the constraints rather than
 * produce proofs. What they pin is that the fold agrees with Solidity — the same
 * fixed vectors as `LockChain.t.sol` — and that a lock can never be confused
 * with a withdrawal.
 */

const record = (claimId: bigint, x: bigint, isOdd: bigint, amount: bigint) =>
  new LockRecord({
    claimId: UInt64.from(claimId),
    recipient: PublicKey.from({ x: Field(x), isOdd: Bool(isOdd === 1n) }),
    amount: UInt64.from(amount),
  });

const VEC1 = '24238330815067196320333506424337783262274560373911706422282298090570990460210';
const VEC2 = '25043209626912400545085844588325141251463434202650320884266165546508507245328';

beforeAll(async () => {
  await LockChain.compile({ proofsEnabled: false });
}, 300_000);

describe('the lock chain', () => {
  /**
   * The cross-language check. Flare folds this in Solidity and Mina replays it
   * in a circuit; a disagreement does not produce a wrong number, it produces a
   * bridge where nothing can ever be claimed.
   */
  it('agrees with the Solidity implementation', () => {
    expect(applyLock(Field(0), record(0n, 1n, 0n, 1_000_000n)).toString()).toBe(VEC1);
    expect(applyLock(Field(VEC1), record(1n, 2n, 1n, 250_000n)).toString()).toBe(VEC2);
  });

  /**
   * The two chains carry the same shape, so only the domain separates them. If
   * it did not, a proof that a withdrawal happened would authorise a mint of a
   * bridged asset.
   */
  it('cannot be confused with the withdrawal chain', () => {
    const lock = applyLock(Field(0), record(3n, 5n, 0n, 42n));
    const withdrawal = applyWithdrawal(
      Field(0),
      new WithdrawalRecord({
        nonce: UInt64.from(3n),
        recipient: PublicKey.from({ x: Field(5n), isOdd: Bool(false) }),
        amount: UInt64.from(42n),
      }),
    );

    expect(lock.toString()).not.toBe(withdrawal.toString());
  });

  it('links a record onto a state', async () => {
    const start = Field(0);
    const l = record(0n, 1n, 0n, 1_000_000n);
    const { proof } = await LockChain.link(start, l);

    expect(proof.publicOutput.from.toString()).toBe('0');
    expect(proof.publicOutput.to.toString()).toBe(applyLock(start, l).toString());
  }, 300_000);

  it('joins segments that meet', async () => {
    const s1 = applyLock(Field(0), record(0n, 1n, 0n, 10n));
    const s2 = applyLock(s1, record(1n, 1n, 0n, 20n));

    const { proof: a } = await LockChain.link(Field(0), record(0n, 1n, 0n, 10n));
    const { proof: b } = await LockChain.link(s1, record(1n, 1n, 0n, 20n));
    const { proof: ab } = await LockChain.merge(a, b);

    expect(ab.publicOutput.from.toString()).toBe('0');
    expect(ab.publicOutput.to.toString()).toBe(s2.toString());
  }, 600_000);

  /**
   * The property the port depends on: a gap in the chain is a gap in the proof.
   * Without this a claimant could skip somebody else's lock and mint against a
   * head that never covered theirs.
   */
  it('refuses segments that do not meet', async () => {
    const { proof: a } = await LockChain.link(Field(0), record(0n, 1n, 0n, 10n));
    const { proof: elsewhere } = await LockChain.link(Field(999), record(1n, 1n, 0n, 20n));

    await expect(LockChain.merge(a, elsewhere)).rejects.toThrow(/do not meet/);
  }, 600_000);

  it('is order dependent', () => {
    const ab = applyLock(applyLock(Field(0), record(0n, 1n, 0n, 7n)), record(1n, 1n, 0n, 9n));
    const ba = applyLock(applyLock(Field(0), record(0n, 1n, 0n, 9n)), record(1n, 1n, 0n, 7n));

    expect(ab.toString()).not.toBe(ba.toString());
  });
});
