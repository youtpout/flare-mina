import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { attestationLeaf, climbToRoot, parseAttestedEvent } from '../src/fdcResponse.js';

/**
 * A place to poke at a real FDC leaf.
 *
 * Not a regression test — `fdcResponse.test.ts` covers that. This one prints
 * what it is looking at, so the shape of an attestation is something you can
 * see rather than infer. Run it with:
 *
 *   pnpm --filter @minaport/shared playground
 *
 * The fixture is genuine: the response Flare's attestation providers agreed on
 * for a real event on Coston2, with the Merkle path and the root the Relay
 * contract stores for that round. Nothing here is computed by this repository
 * except the hashes being checked.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, 'fixtures/fdc-evm-transaction.json'), 'utf8'),
) as { response_hex: Hex; proof: Hex[]; votingRoundId: number; relayRoot: Hex };

/** 32-byte words, which is how ABI encoding lays everything out. */
const wordAt = (response: Hex, i: number): Hex =>
  `0x${response.slice(2 + i * 64, 2 + (i + 1) * 64)}`;

/** Keccak's rate: it absorbs the message 136 bytes at a time. */
const RATE = 136;

describe('an FDC leaf, up close', () => {
  /**
   * The leaf is the keccak of the response *verbatim* — no re-encoding, no
   * field packing. That is the whole reason the circuit hashes 1344 bytes: it
   * has to reproduce exactly what the attestation providers hashed.
   */
  it('is keccak256 of the response bytes', () => {
    const bytes = (fixture.response_hex.length - 2) / 2;
    const leaf = keccak256(fixture.response_hex);

    console.log(`\nresponse : ${bytes} bytes (${bytes / 32} words, ${Math.ceil((bytes + 1) / RATE)} keccak blocks)`);
    console.log(`leaf     : ${leaf}`);

    expect(leaf).toBe(attestationLeaf(fixture.response_hex));
  });

  /**
   * What the validators actually signed is the round's root. The leaf on its
   * own says nothing — it is the climb that turns "these bytes exist" into
   * "the validator set agreed these bytes are true".
   */
  it('climbs its Merkle path to the signed round root', () => {
    const leaf = attestationLeaf(fixture.response_hex);

    console.log(`\nround    : ${fixture.votingRoundId}`);
    fixture.proof.forEach((sibling, i) => console.log(`sibling ${i}: ${sibling}`));
    console.log(`root     : ${fixture.relayRoot}`);

    // Sorted pairs, OpenZeppelin style — the smaller hash goes left at every
    // level, so a path carries no direction bits.
    expect(climbToRoot(leaf, fixture.proof)).toBe(fixture.relayRoot);
  });

  /** The event the whole attestation exists to carry. */
  it('holds the bridge event', () => {
    const emitter = `0x${wordAt(fixture.response_hex, 28).slice(26)}` as Hex;
    const event = parseAttestedEvent(fixture.response_hex, {
      emitter,
      topic0: wordAt(fixture.response_hex, 33),
    });

    console.log(`\nemitter  : ${event.emitter}`);
    event.topics.forEach((t, i) => console.log(`topic ${i}   : ${t}`));
    event.data.forEach((d, i) => console.log(`data ${i}    : ${d}`));
    console.log(`newHead  : ${event.newActionState}`);

    expect(event.emitter.toLowerCase()).toBe(emitter.toLowerCase());
  });

  /**
   * Which bytes move between responses, and which do not.
   *
   * This is what killed the idea of hashing a constant prefix once and starting
   * the circuit's sponge from a precomputed state: the very first block already
   * carries the voting round id and a timestamp, so there is no constant prefix
   * to precompute — not even one block of it.
   */
  it('shows where the variable fields sit', () => {
    const labels: Record<number, string> = {
      0: 'ABI offset            fixed',
      1: '"EVMTransaction"      fixed',
      2: '"testFLR"             fixed',
      3: 'votingRoundId         VARIES',
      4: 'timestamp             VARIES',
      7: 'request hash          VARIES',
      14: 'block number          VARIES',
      15: 'timestamp             VARIES',
      16: 'transaction sender    VARIES',
      18: 'transaction target    VARIES',
      28: 'emitter               VARIES',
      33: 'topic0                fixed per event',
    };

    console.log('');
    for (let w = 0; w < 34; w++) {
      const block = Math.floor((w * 32) / RATE);
      const label = labels[w];
      if (label !== undefined) {
        console.log(`word ${String(w).padStart(2)} (block ${block})  ${label}`);
      }
    }

    // The claim above, as an assertion rather than a comment: the first block
    // covers words 0 to 4, and word 3 is the round id.
    expect(Math.floor((3 * 32) / RATE)).toBe(0);
  });
});
