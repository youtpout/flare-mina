import { beforeAll, describe, expect, it } from 'vitest';
import { Bool, Field, PublicKey, UInt64 } from 'o1js';
import { TransferChain, TransferRecord, applyTransfer, tokenField } from '../src/TransferChain.js';

/**
 * Replaying the one chain every Flare -> Mina transfer folds into.
 *
 * Run with `proofsEnabled: false`, so these exercise the constraints rather than
 * produce proofs. What they pin is that the fold agrees with Solidity — the same
 * fixed vectors as `TransferChain.t.sol` — and that a segment picks out the
 * first record of its token, which is what makes a shared chain safe for a
 * single-asset port.
 */

const FXRP = tokenField('0x8b4abA9C4BD7DD961659b02129beE20c6286e17F');
const FMINA = tokenField('0x1234567890AbcdEF1234567890aBcdef12345678');

const record = (index: bigint, token: Field, x: bigint, isOdd: bigint, amount: bigint) =>
  new TransferRecord({
    index: UInt64.from(index),
    token,
    recipient: PublicKey.from({ x: Field(x), isOdd: Bool(isOdd === 1n) }),
    amount: UInt64.from(amount),
  });

const VEC1 = '16384375983255661953484451000793570174029057839055331727320303929127563660068';
const VEC2 = '8416979730368417248677395568704319549108660798938386199281841772177762886402';

beforeAll(async () => {
  await TransferChain.compile({ proofsEnabled: false });
}, 300_000);

describe('the transfer chain', () => {
  /**
   * The cross-language check. Flare folds this in Solidity and Mina replays it
   * in a circuit; a disagreement does not produce a wrong number, it produces a
   * bridge where nothing can ever be claimed.
   */
  it('agrees with the Solidity implementation', () => {
    expect(applyTransfer(Field(0), record(0n, FXRP, 1n, 0n, 1_000_000n)).toString()).toBe(VEC1);
    expect(applyTransfer(Field(VEC1), record(1n, FMINA, 2n, 1n, 250_000n)).toString()).toBe(VEC2);
  });

  /**
   * The token is in the fold, so the same transfer of a different asset is a
   * different link. Without it a port could not tell its own entries from the
   * ones it must step over, and one chain for four assets would not work.
   */
  it('binds the token into the link', () => {
    const asFxrp = applyTransfer(Field(0), record(0n, FXRP, 1n, 0n, 5n));
    const asFmina = applyTransfer(Field(0), record(0n, FMINA, 1n, 0n, 5n));

    expect(asFxrp.toString()).not.toBe(asFmina.toString());
  });

  it('links a record onto a state', async () => {
    const start = Field(0);
    const r = record(0n, FXRP, 1n, 0n, 1_000_000n);
    const { proof } = await TransferChain.link(start, FXRP, r);

    expect(proof.publicOutput.from.toString()).toBe('0');
    expect(proof.publicOutput.to.toString()).toBe(applyTransfer(start, r).toString());
    expect(proof.publicOutput.found.toBoolean()).toBe(true);
    expect(proof.publicOutput.firstAmount.toString()).toBe('1000000');
    expect(proof.publicOutput.stateAfterFirst.toString()).toBe(proof.publicOutput.to.toString());
  }, 300_000);

  /**
   * The property the shared chain rests on. A port steps over records belonging
   * to other assets, and the circuit is what decides which those are — if a link
   * carrying its token could report `found: false`, the port would skip a
   * transfer that then becomes permanently unclaimable.
   */
  it('reports a foreign record as not found', async () => {
    const { proof } = await TransferChain.link(Field(0), FXRP, record(0n, FMINA, 1n, 0n, 5n));

    expect(proof.publicOutput.found.toBoolean()).toBe(false);
    expect(proof.publicOutput.token.toString()).toBe(FXRP.toString());
    expect(proof.publicOutput.stateAfterFirst.toString()).toBe('0');
  }, 300_000);

  it('joins segments that meet, and keeps the first of the token', async () => {
    const s1 = applyTransfer(Field(0), record(0n, FMINA, 1n, 0n, 10n));
    const s2 = applyTransfer(s1, record(1n, FXRP, 1n, 0n, 20n));

    const { proof: a } = await TransferChain.link(Field(0), FXRP, record(0n, FMINA, 1n, 0n, 10n));
    const { proof: b } = await TransferChain.link(s1, FXRP, record(1n, FXRP, 1n, 0n, 20n));
    const { proof: ab } = await TransferChain.merge(a, b);

    expect(ab.publicOutput.from.toString()).toBe('0');
    expect(ab.publicOutput.to.toString()).toBe(s2.toString());
    // The lower half was foreign, so the first FXRP record is the upper's.
    expect(ab.publicOutput.found.toBoolean()).toBe(true);
    expect(ab.publicOutput.firstAmount.toString()).toBe('20');
    expect(ab.publicOutput.stateAfterFirst.toString()).toBe(s2.toString());
  }, 600_000);

  /**
   * "First" has to survive however the range was split, or a consumer would pay
   * the wrong transfer and move its cursor past the right one.
   */
  it('keeps the earlier record when both halves hold one', async () => {
    const s1 = applyTransfer(Field(0), record(0n, FXRP, 1n, 0n, 11n));

    const { proof: a } = await TransferChain.link(Field(0), FXRP, record(0n, FXRP, 1n, 0n, 11n));
    const { proof: b } = await TransferChain.link(s1, FXRP, record(1n, FXRP, 1n, 0n, 22n));
    const { proof: ab } = await TransferChain.merge(a, b);

    expect(ab.publicOutput.firstAmount.toString()).toBe('11');
    expect(ab.publicOutput.stateAfterFirst.toString()).toBe(s1.toString());
  }, 600_000);

  /**
   * A gap in the chain must be a gap in the proof. Without this a claimant could
   * skip somebody else's transfer and mint against a head that never covered
   * theirs.
   */
  it('refuses segments that do not meet', async () => {
    const { proof: a } = await TransferChain.link(Field(0), FXRP, record(0n, FXRP, 1n, 0n, 10n));
    const { proof: elsewhere } = await TransferChain.link(
      Field(999),
      FXRP,
      record(1n, FXRP, 1n, 0n, 20n),
    );

    await expect(TransferChain.merge(a, elsewhere)).rejects.toThrow(/do not meet/);
  }, 600_000);

  /**
   * Otherwise a caller could merge a segment examined for FXRP with one examined
   * for C2FLR and claim the result contains neither.
   */
  it('refuses to merge segments examined for different tokens', async () => {
    const s1 = applyTransfer(Field(0), record(0n, FXRP, 1n, 0n, 10n));
    const { proof: a } = await TransferChain.link(Field(0), FXRP, record(0n, FXRP, 1n, 0n, 10n));
    const { proof: b } = await TransferChain.link(s1, FMINA, record(1n, FMINA, 1n, 0n, 20n));

    await expect(TransferChain.merge(a, b)).rejects.toThrow(/different tokens/);
  }, 600_000);

  it('is order dependent', () => {
    const ab = applyTransfer(
      applyTransfer(Field(0), record(0n, FXRP, 1n, 0n, 7n)),
      record(1n, FXRP, 1n, 0n, 9n),
    );
    const ba = applyTransfer(
      applyTransfer(Field(0), record(0n, FXRP, 1n, 0n, 9n)),
      record(1n, FXRP, 1n, 0n, 7n),
    );

    expect(ab.toString()).not.toBe(ba.toString());
  });

  /** The empty segment contains nothing, whatever it was examined for. */
  it('starts empty', async () => {
    const { proof } = await TransferChain.empty(Field(0), FXRP);

    expect(proof.publicOutput.from.toString()).toBe('0');
    expect(proof.publicOutput.to.toString()).toBe('0');
    expect(proof.publicOutput.found.toBoolean()).toBe(false);
  }, 300_000);
});
