import { beforeAll, describe, expect, it } from 'vitest';
import { Bool, Field, PublicKey, UInt64 } from 'o1js';
import {
  WithdrawalChain,
  WithdrawalRecord,
  applyWithdrawal,
} from '../src/WithdrawalChain.js';

/**
 * Replaying the chain Flare builds.
 *
 * Run with `proofsEnabled: false`, so these exercise the constraints rather than
 * produce proofs. What they pin is that the fold agrees with Solidity — checked
 * against the same fixed vectors as `WithdrawalChain.t.sol`, both of which came
 * from o1js originally — and that segments cannot be joined unless they meet.
 */

const record = (nonce: bigint, x: bigint, isOdd: bigint, amount: bigint) =>
  new WithdrawalRecord({
    nonce: UInt64.from(nonce),
    recipient: PublicKey.from({ x: Field(x), isOdd: Bool(isOdd === 1n) }),
    amount: UInt64.from(amount),
  });

beforeAll(async () => {
  await WithdrawalChain.compile({ proofsEnabled: false });
}, 300_000);

describe('the withdrawal chain', () => {
  /**
   * The cross-language check. Flare computes this in Solidity and Mina in a
   * circuit; if they ever disagree the bridge is unusable, and no single-sided
   * test would notice.
   */
  it('agrees with the Solidity implementation', () => {
    expect(applyWithdrawal(Field(0), record(0n, 1n, 0n, 1_000_000_000n)).toString()).toBe(
      '20338167948893865203789535858143587872632287136678581407774871091195425220612',
    );

    expect(
      applyWithdrawal(
        Field(7),
        record(
          1n,
          28948022309329048855892746252171976963363056481941560715954676764349967630336n,
          1n,
          5n,
        ),
      ).toString(),
    ).toBe('22763620096517538563887448556698494028164519701847201535409814009599771134055');
  });

  it('links a record onto a state', async () => {
    const start = Field(0);
    const w = record(0n, 1n, 0n, 1_000_000_000n);
    const { proof } = await WithdrawalChain.link(start, w);

    expect(proof.publicOutput.from.toString()).toBe('0');
    expect(proof.publicOutput.to.toString()).toBe(applyWithdrawal(start, w).toString());
  }, 300_000);

  it('merges consecutive links into one segment', async () => {
    const s0 = Field(0);
    const w0 = record(0n, 1n, 0n, 100n);
    const s1 = applyWithdrawal(s0, w0);
    const w1 = record(1n, 2n, 0n, 200n);
    const s2 = applyWithdrawal(s1, w1);

    const { proof: a } = await WithdrawalChain.link(s0, w0);
    const { proof: b } = await WithdrawalChain.link(s1, w1);
    const { proof: ab } = await WithdrawalChain.merge(a, b);

    expect(ab.publicOutput.from.toString()).toBe('0');
    expect(ab.publicOutput.to.toString()).toBe(s2.toString());
  }, 300_000);

  /**
   * The property the whole design rests on. Without it a prover could staple
   * together segments from unrelated points and present the result as a
   * continuation of the chain Flare actually built.
   */
  it('refuses segments that do not meet', async () => {
    const w0 = record(0n, 1n, 0n, 100n);
    const { proof: a } = await WithdrawalChain.link(Field(0), w0);
    // Starts somewhere else entirely.
    const { proof: elsewhere } = await WithdrawalChain.link(Field(999), record(1n, 2n, 0n, 200n));

    await expect(WithdrawalChain.merge(a, elsewhere)).rejects.toThrow(/do not meet/);
  }, 300_000);

  /**
   * The empty segment exists so the newest withdrawal is not a special case: its
   * tail is empty, and it still has to supply a proof.
   */
  it('gives an empty segment that merges as an identity', async () => {
    const w = record(0n, 1n, 0n, 100n);
    const s1 = applyWithdrawal(Field(0), w);

    const { proof: link } = await WithdrawalChain.link(Field(0), w);
    const { proof: tail } = await WithdrawalChain.empty(s1);
    const { proof: joined } = await WithdrawalChain.merge(link, tail);

    expect(joined.publicOutput.from.toString()).toBe('0');
    expect(joined.publicOutput.to.toString()).toBe(s1.toString());
  }, 300_000);

  /** Order is the point of a chain: the same records elsewhere give another state. */
  it('is order sensitive', () => {
    const w0 = record(0n, 1n, 0n, 100n);
    const w1 = record(1n, 2n, 0n, 200n);
    const ab = applyWithdrawal(applyWithdrawal(Field(0), w0), w1);
    const ba = applyWithdrawal(applyWithdrawal(Field(0), w1), w0);

    expect(ab.toString()).not.toBe(ba.toString());
  });
});
