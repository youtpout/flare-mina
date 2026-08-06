import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import {
  attestationLeaf,
  climbToRoot,
  parseAttestedEvent,
  verifyAttestation,
} from '../src/fdcResponse.js';

/**
 * Decoding a real FDC attestation.
 *
 * The fixture is not synthetic: it is the response Flare's attestation
 * providers agreed on for a real `AssetLocked` on Coston2, fetched from the DA
 * layer, and `relayRoot` is what the Relay contract stores for that round. So
 * the climb below is checked against a value the validator set signed, not
 * against anything this repository computed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, 'fixtures/fdc-evm-transaction.json'), 'utf8'),
) as { response_hex: Hex; proof: Hex[]; votingRoundId: number; relayRoot: Hex };

/** The vault, and the `AssetLocked` signature. */
const EXPECTED = {
  emitter: '0xa179E908C3F1156Edda0BD5f1A0B3b3f419f9F90' as Hex,
  topic0: '0x078ee1eead8e83dabf8464df5a5e308db068b136607c9f7bef8e86f6fc783add' as Hex,
};

describe('an FDC EVMTransaction response', () => {
  /**
   * The whole point of the attestation: this leaf is under the root the Flare
   * validators signed, so the event in it happened.
   */
  it('climbs to the round root the Relay contract stores', () => {
    const climbed = climbToRoot(attestationLeaf(fixture.response_hex), fixture.proof);
    expect(climbed.toLowerCase()).toBe(fixture.relayRoot.toLowerCase());
  });

  it('finds the bridge event and its action state', () => {
    const event = parseAttestedEvent(fixture.response_hex, EXPECTED);

    expect(event.emitter.toLowerCase()).toBe(EXPECTED.emitter.toLowerCase());
    // claimId 0, FXRP, 5.000000 at six decimals.
    expect(BigInt(event.topics[1]!)).toBe(0n);
    expect(BigInt(event.data[1]!)).toBe(5_000_000n);
    // previousActionState: this was the first lock on that token's chain.
    expect(BigInt(event.data[2]!)).toBe(0n);
    expect(event.newActionState).toBe(
      BigInt('0x3c07f9225ce752e4a73a57ecaa41270044f4f0426431f47907577853676e66f6'),
    );
  });

  /**
   * The offsets hold only because the request was trimmed. A wider response
   * moves every word, and reading the old positions would yield a plausible
   * number from the wrong place — which is worse than failing.
   */
  it('refuses a response of unexpected shape', () => {
    const padded = (fixture.response_hex + '00'.repeat(32)) as Hex;
    expect(() => parseAttestedEvent(padded, EXPECTED)).toThrow(/trimmed response/);
  });

  it('refuses an event from another contract', () => {
    expect(() =>
      parseAttestedEvent(fixture.response_hex, {
        ...EXPECTED,
        emitter: '0x0000000000000000000000000000000000000001',
      }),
    ).toThrow(/expected/);
  });

  it('refuses a different event signature', () => {
    expect(() =>
      parseAttestedEvent(fixture.response_hex, { ...EXPECTED, topic0: `0x${'11'.repeat(32)}` }),
    ).toThrow(/signature/);
  });

  /** A proof that does not reach the round root proves nothing about the event. */
  it('refuses a proof that climbs elsewhere', () => {
    expect(() =>
      verifyAttestation(fixture.response_hex, fixture.proof, `0x${'22'.repeat(32)}`, EXPECTED),
    ).toThrow(/not to the round root/);
  });

  /**
   * Sorted pairs, not a left/right flag. Swapping the order of a sibling must
   * not change the climb, or the implementation is not the one Flare uses.
   */
  it('is insensitive to sibling order, because pairs are sorted', () => {
    const leaf = attestationLeaf(fixture.response_hex);
    const one = climbToRoot(leaf, [fixture.proof[0]!]);
    const other = climbToRoot(fixture.proof[0]!, [leaf]);
    expect(one).toBe(other);
  });
});
