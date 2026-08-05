import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import {
  FDC_PROTOCOL_ID,
  addressFromPublicKey,
  harvestPolicyKeys,
  knownWeight,
  signingPolicyHash,
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

describe('harvesting the validator keys', () => {
  const calls = Object.values(fixtures).map((f) => parseRelayCalldata(f.calldata));

  it('recovers keys for every voter that signed', async () => {
    const { known, missing } = await harvestPolicyKeys(calls[0]!.policy, calls);

    const signed = new Set(calls.flatMap((c) => c.signatures.map((s) => s.index)));
    expect(known.map((k) => k.index).sort()).toEqual([...signed].sort());
    // Everyone else is unknown, which is the honest state rather than a bug.
    expect(known.length + missing.length).toBe(calls[0]!.policy.voters.length);
  });

  /**
   * The point of harvesting rather than reading: a voter absent from one round
   * appears in another, and two rounds already cover more than one.
   */
  it('accumulates across rounds', async () => {
    const fromOne = await harvestPolicyKeys(calls[0]!.policy, [calls[0]!]);
    const fromBoth = await harvestPolicyKeys(calls[0]!.policy, calls);
    expect(fromBoth.known.length).toBeGreaterThanOrEqual(fromOne.known.length);
  });

  /** A key from a different reward epoch means different indices entirely. */
  it('ignores calls from another reward epoch', async () => {
    const foreign = {
      ...calls[0]!,
      policy: { ...calls[0]!.policy, rewardEpochId: calls[0]!.policy.rewardEpochId + 1 },
    };
    const { known } = await harvestPolicyKeys(calls[0]!.policy, [foreign]);
    expect(known).toHaveLength(0);
  });

  /**
   * The binding that makes a recovered key usable. Corrupting the message
   * changes the digest, recovery still yields a key, and it is silently the
   * wrong one — so it must be rejected on the address check alone.
   */
  it('drops a key whose address does not match the policy', async () => {
    const tampered = {
      ...calls[0]!,
      message: { ...calls[0]!.message, encoded: `0x${'11'.repeat(38)}` as const },
    };
    const { known } = await harvestPolicyKeys(calls[0]!.policy, [tampered]);
    expect(known).toHaveLength(0);
  });

  it('reports how much weight the known keys carry', async () => {
    const { known } = await harvestPolicyKeys(calls[0]!.policy, calls);
    expect(knownWeight(known)).toBeGreaterThanOrEqual(calls[0]!.policy.threshold);
  });
});

describe('the authorised signer set', () => {
  const calls = Object.values(fixtures).map((f) => parseRelayCalldata(f.calldata));

  /**
   * What makes the list authoritative rather than merely present.
   *
   * Every relay transaction carries a copy of the validator set, but a copy
   * proves nothing on its own. `Relay.toSigningPolicyHash(rewardEpochId)` is
   * the commitment governance wrote when the epoch opened, and `relay()`
   * rejects any calldata whose policy does not hash to it.
   *
   * The expected value below was read from Coston2 at reward epoch 5902. It is
   * pinned rather than fetched so the suite stays offline, but it is a real
   * on-chain value, not one this implementation produced.
   */
  it('reproduces the hash Relay stores for the epoch', () => {
    const policy = calls[0]!.policy;
    expect(policy.rewardEpochId).toBe(5902);
    expect(signingPolicyHash(policy)).toBe(
      '0x4059cd5063e49a90718d0c48b1b13efccdf6f958952a3bf736309967cb816973',
    );
  });

  /** Both fixtures relayed under the same epoch, so both must hash the same. */
  it('agrees across transactions of the same epoch', () => {
    const hashes = new Set(calls.map((c) => signingPolicyHash(c.policy)));
    expect(hashes.size).toBe(1);
  });

  /** A single altered weight has to change the commitment. */
  it('changes when a voter weight is tampered with', () => {
    const policy = calls[0]!.policy;
    const bytes = policy.encoded.slice(2);
    // Last voter's weight is the final 2 bytes of the packed policy.
    const tampered = {
      ...policy,
      encoded: `0x${bytes.slice(0, -4)}ffff` as const,
    };
    expect(signingPolicyHash(tampered)).not.toBe(signingPolicyHash(policy));
  });
});
