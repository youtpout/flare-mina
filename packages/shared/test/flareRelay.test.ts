import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import {
  FDC_PROTOCOL_ID,
  addressFromPublicKey,
  parseRelayCalldata,
  recoverSigners,
} from '../src/flareRelay.js';

/**
 * Decoding real Flare finalisations.
 *
 * The fixtures are two actual Coston2 transactions, one per relayed protocol,
 * captured with their `ProtocolMessageRelayed` logs. Testing against synthetic
 * calldata would only prove the parser agrees with whatever encoder wrote it;
 * these prove it agrees with Flare.
 */

type Fixture = {
  protocolId: number;
  votingRoundId: number;
  isSecureRandom: boolean;
  merkleRoot: Hex;
  txHash: Hex;
  calldata: Hex;
};

const fixtures: Record<string, Fixture> = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/relayCalldata.json', import.meta.url)), 'utf8'),
);

describe.each(Object.values(fixtures))('relay calldata for protocol $protocolId', (fixture) => {
  const call = parseRelayCalldata(fixture.calldata);

  /**
   * The decode is only correct if it lands on the values the contract itself
   * reported in its event — the parser cannot mark its own homework.
   */
  it('recovers the message the event announced', () => {
    expect(call.message.protocolId).toBe(fixture.protocolId);
    expect(call.message.votingRoundId).toBe(fixture.votingRoundId);
    expect(call.message.isSecureRandom).toBe(fixture.isSecureRandom);
    expect(call.message.merkleRoot.toLowerCase()).toBe(fixture.merkleRoot.toLowerCase());
  });

  it('reads a plausible signing policy', () => {
    expect(call.policy.voters.length).toBeGreaterThan(0);
    // Indices are positional and dense: the fold orders signatures by them.
    call.policy.voters.forEach((v, i) => {
      expect(v.index).toBe(i);
      expect(v.address).toMatch(/^0x[0-9a-f]{40}$/i);
      // Zero is legitimate — a registered voter with no stake this epoch. An
      // earlier version of this test asserted otherwise and was simply wrong
      // about Flare.
      expect(v.weight).toBeGreaterThanOrEqual(0);
    });

    const total = call.policy.voters.reduce((sum, v) => sum + v.weight, 0);
    expect(total).toBeGreaterThan(0);
    expect(call.policy.threshold).toBeGreaterThan(0);
    expect(call.policy.threshold).toBeLessThanOrEqual(total);
  });

  /**
   * The property that makes the fixture a valid finalisation, and the number
   * `requiredWeight` on the Mina side has to match: Flare's threshold is just
   * over half the total weight, and the signatures present clear it.
   */
  it('carries enough signing weight to clear the threshold', () => {
    const signed = call.signatures.reduce(
      (sum, s) => sum + (call.policy.voters[s.index]?.weight ?? 0),
      0,
    );
    expect(signed).toBeGreaterThanOrEqual(call.policy.threshold);
  });

  it('consumes the calldata exactly', () => {
    // parseRelayCalldata throws on a trailing-byte mismatch, so reaching here
    // means signatures * 67 accounted for every remaining byte.
    expect(call.signatures.length).toBeGreaterThan(0);
    call.signatures.forEach((s) => {
      expect(s.v === 27 || s.v === 28).toBe(true);
      expect(s.index).toBeLessThan(call.policy.voters.length);
    });
  });

  /**
   * The check that ties everything together.
   *
   * If the message bytes were decoded from the wrong offset, or hashed the
   * wrong way, recovery still succeeds — it just yields a different key. The
   * only way to know the hash is right is that every recovered key hashes to
   * the address Flare's own policy lists at that signature's index.
   *
   * This is also what makes the public keys usable on Mina: the circuit
   * verifies against keys, and the policy only stores addresses.
   */
  it('recovers signers that match the policy addresses', async () => {
    const recovered = await recoverSigners(call.message, call.signatures);

    for (const { index, publicKey } of recovered) {
      const voter = call.policy.voters[index];
      expect(voter).toBeDefined();
      expect(addressFromPublicKey(publicKey).toLowerCase()).toBe(voter!.address.toLowerCase());
    }
  });

  /** Signatures need not be sorted in calldata, but must be distinct signers. */
  it('has no signer signing twice', () => {
    const seen = new Set(call.signatures.map((s) => s.index));
    expect(seen.size).toBe(call.signatures.length);
  });
});

it('captured an FDC round, not only FTSO', () => {
  const protocols = Object.values(fixtures).map((f) => f.protocolId);
  expect(protocols).toContain(FDC_PROTOCOL_ID);
});
