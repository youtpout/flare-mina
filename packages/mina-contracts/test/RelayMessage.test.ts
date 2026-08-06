import { beforeAll, describe, expect, it } from 'vitest';
import { Bytes38, RelayMessage } from '../src/RelayMessage.js';

/**
 * The binding that removes the co-signature.
 *
 * Checked against a real `relay()` message harvested from Coston2, not one this
 * file made up: the point is that the circuit agrees with what Flare's
 * validators actually sign, and a self-consistent fixture would prove nothing
 * about that.
 *
 * `DIGEST` is what `signedMessageHash` in packages/shared produces for this
 * message — the same function whose output live validator signatures already
 * recover against, which is how their public keys are found in the first place.
 * So agreeing with it is agreeing with the chain.
 */

/** Coston2, round 1,417,908. Protocol 100; FDC rounds use the same envelope. */
const MESSAGE = '640015a2b401be78fdab2da71bd4c013036c2116c7c7b9776a5b0c39c71d7dd01e6663e43e23';
const DIGEST = 'f2b786afc7f18d98b9a7bf96fd646c31790b2fff593ce191aee515fa56832ba9';

const PROTOCOL_ID = 100;
const VOTING_ROUND = 1_417_908;

beforeAll(async () => {
  await RelayMessage.compile({ proofsEnabled: false });
}, 600_000);

describe('the relay message binding', () => {
  /**
   * The whole point. Before this, a proof said "the validators signed some 32
   * bytes"; the escrow had no way to check which, so an admin key asserted it.
   */
  it('recomputes the digest a validator signs', async () => {
    const { proof } = await RelayMessage.bind(Bytes38.fromHex(MESSAGE));
    expect(proof.publicOutput.digest.toHex()).toBe(DIGEST);
  }, 600_000);

  it('reads what the message says', async () => {
    const { proof } = await RelayMessage.bind(Bytes38.fromHex(MESSAGE));
    const out = proof.publicOutput;

    expect(Number(out.protocolId.toBigint())).toBe(PROTOCOL_ID);
    expect(Number(out.votingRoundId.toBigint())).toBe(VOTING_ROUND);
    // Everything after the 6-byte header is the round's root.
    expect(out.merkleRoot.toHex()).toBe(MESSAGE.slice(12));
  }, 600_000);

  /**
   * Two rounds differ in their root, so a digest lifted from one can never
   * authorise the other. That substitution is exactly what an unbound digest
   * allowed, and it is the reason this program exists.
   */
  it('produces a different digest for a different root', async () => {
    const other = MESSAGE.slice(0, 12) + 'ff'.repeat(32);

    const a = (await RelayMessage.bind(Bytes38.fromHex(MESSAGE))).proof;
    const b = (await RelayMessage.bind(Bytes38.fromHex(other))).proof;

    expect(a.publicOutput.digest.toHex()).not.toBe(b.publicOutput.digest.toHex());
  }, 900_000);
});
