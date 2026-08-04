import { beforeAll, describe, expect, it } from 'vitest';
import { Field, UInt32 } from 'o1js';
import {
  Bytes32,
  EcdsaSignature,
  Secp256k1,
  SignerInput,
  SigningPolicyFold,
} from '../src/SigningPolicyFold.js';

/**
 * The fold that replaces the withdrawal attestor.
 *
 * These run with `proofsEnabled: false`, so they exercise the constraints
 * rather than produce proofs — the timings live in the benchmark. What they
 * pin is the part a wrong implementation would get quietly wrong: that `count`
 * means *distinct signers*, and that two proofs about different roots cannot
 * be combined.
 */

const POLICY = Field(0xf1a2e);

type Voter = { key: bigint; publicKey: Secp256k1; index: number; weight: number };

let message: Bytes32;
let voters: Voter[];

beforeAll(async () => {
  await SigningPolicyFold.compile({ proofsEnabled: false });

  message = Bytes32.random();
  // Eight, as Coston2's signing policy has today. Nothing below depends on
  // that number — the fold is generic in depth, which is what keeps a
  // testnet-sized threshold from becoming a mainnet-sized bug.
  voters = Array.from({ length: 8 }, (_, i) => {
    const key = Secp256k1.Scalar.random().toBigInt();
    return { key, publicKey: Secp256k1.generator.scale(key), index: i, weight: 100 * (i + 1) };
  });
}, 300_000);

function signerFor(voter: Voter, over: Bytes32 = message): SignerInput {
  return new SignerInput({
    publicKey: voter.publicKey,
    signature: EcdsaSignature.signHash(over, voter.key),
    index: UInt32.from(voter.index),
    weight: UInt32.from(voter.weight),
  });
}

async function single(voter: Voter, over: Bytes32 = message) {
  const { proof } = await SigningPolicyFold.single(message, POLICY, signerFor(voter, over));
  return proof;
}

describe('merging validator signatures', () => {
  it('sums count and weight across a merge', async () => {
    const a = await single(voters[0]!);
    expect(a.publicOutput.count.toString()).toBe('1');
    expect(a.publicOutput.weight.toString()).toBe('100');

    const b = await single(voters[1]!);
    const { proof: ab } = await SigningPolicyFold.merge(a, b);
    const c = await single(voters[2]!);
    const { proof: abc } = await SigningPolicyFold.merge(ab, c);

    expect(abc.publicOutput.count.toString()).toBe('3');
    // 100 + 200 + 300. Weight, not headcount, is what Flare's threshold is
    // expressed in, so a consumer checking only the count is making a weaker
    // claim than Flare does.
    expect(abc.publicOutput.weight.toString()).toBe('600');
    expect(abc.publicOutput.minIndex.toString()).toBe('0');
    expect(abc.publicOutput.maxIndex.toString()).toBe('2');
  }, 300_000);

  /**
   * The property the whole design rests on.
   *
   * Without disjoint index ranges, merging a proof with itself doubles both
   * count and weight — and a threshold of five would be met by one validator
   * signing once.
   */
  it('refuses to merge a proof with itself', async () => {
    const a = await single(voters[3]!);
    await expect(SigningPolicyFold.merge(a, a)).rejects.toThrow(/strictly ascending/);
  }, 300_000);

  /** Overlapping ranges are refused for the same reason, and by the same check. */
  it('refuses ranges that overlap or go backwards', async () => {
    const high = await single(voters[5]!);
    const low = await single(voters[2]!);
    await expect(SigningPolicyFold.merge(high, low)).rejects.toThrow(/strictly ascending/);
  }, 300_000);

  it('refuses a signature over a different message', async () => {
    const other = Bytes32.random();
    await expect(
      SigningPolicyFold.single(message, POLICY, signerFor(voters[0]!, other)),
    ).rejects.toThrow();
  }, 300_000);

  /**
   * Each leaf carries the root it verified, and a merge checks both sides
   * agree. Otherwise a valid signature over one root could be counted towards
   * the threshold for another.
   */
  it('refuses to merge proofs about different roots', async () => {
    const here = await single(voters[0]!);

    const elsewhere = Bytes32.random();
    const { proof: there } = await SigningPolicyFold.single(
      elsewhere,
      POLICY,
      signerFor(voters[1]!, elsewhere),
    );

    await expect(SigningPolicyFold.merge(here, there)).rejects.toThrow(/signed root/);
  }, 300_000);
});
