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
 * means *distinct signers*, and that a fold cannot drift off its message.
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

describe('folding validator signatures', () => {
  it('accumulates count and weight across a chain', async () => {
    const { proof: first } = await SigningPolicyFold.base(message, POLICY, signerFor(voters[0]!));
    expect(first.publicOutput.count.toString()).toBe('1');
    expect(first.publicOutput.weight.toString()).toBe('100');

    const { proof: second } = await SigningPolicyFold.step(first, signerFor(voters[1]!));
    const { proof: third } = await SigningPolicyFold.step(second, signerFor(voters[2]!));

    expect(third.publicOutput.count.toString()).toBe('3');
    // 100 + 200 + 300. Weight, not headcount, is what Flare's threshold is
    // expressed in, so a consumer checking only the count is making a weaker
    // claim than Flare does.
    expect(third.publicOutput.weight.toString()).toBe('600');
  }, 300_000);

  /**
   * The property the whole design rests on.
   *
   * Without strictly increasing indices, one signature folded five times reads
   * as five signers — and a threshold of five would be met by a single
   * validator.
   */
  it('refuses the same signer twice', async () => {
    const { proof } = await SigningPolicyFold.base(message, POLICY, signerFor(voters[3]!));
    await expect(SigningPolicyFold.step(proof, signerFor(voters[3]!))).rejects.toThrow(
      /strictly ordered/,
    );
  }, 300_000);

  /** Out-of-order is refused for the same reason, and by the same check. */
  it('refuses a signer that goes backwards', async () => {
    const { proof } = await SigningPolicyFold.base(message, POLICY, signerFor(voters[5]!));
    await expect(SigningPolicyFold.step(proof, signerFor(voters[2]!))).rejects.toThrow(
      /strictly ordered/,
    );
  }, 300_000);

  it('refuses a signature over a different message', async () => {
    const other = Bytes32.random();
    await expect(
      SigningPolicyFold.base(message, POLICY, signerFor(voters[0]!, other)),
    ).rejects.toThrow();
  }, 300_000);

  /**
   * A step signs the message the chain started with, not one it supplies, so
   * two roots cannot be merged into one claim. Checked by folding a signature
   * that is valid over a different root and watching it fail against the
   * carried one.
   */
  it('pins every step to the message the fold began with', async () => {
    const { proof } = await SigningPolicyFold.base(message, POLICY, signerFor(voters[0]!));
    const elsewhere = Bytes32.random();

    await expect(
      SigningPolicyFold.step(proof, signerFor(voters[1]!, elsewhere)),
    ).rejects.toThrow();

    expect(proof.publicOutput.message.toHex()).toBe(message.toHex());
  }, 300_000);
});
