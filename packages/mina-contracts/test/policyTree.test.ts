import { Bytes38, RelayMessage } from '../src/RelayMessage.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UInt32 } from 'o1js';
import type { Hex } from 'viem';
import {
  harvestPolicyKeys,
  parseRelayCalldata,
  signedMessageHash,
  type PolicyKey,
  type RelayCall,
} from '@minaport/shared';
import { buildPolicyTree, toSecp256k1 } from '../src/policyTree.js';
import {
  Bytes32,
  EcdsaSignature,
  SignerInput,
  SigningPolicyFold,
} from '../src/SigningPolicyFold.js';

/**
 * Real Coston2 validator signatures, verified by the Mina circuit.
 *
 * Every other test here signs with keys it generated itself, which proves the
 * circuit is self-consistent and nothing else. This one takes signatures Flare's
 * validators actually produced, the public keys recovered from them, and the
 * signing policy Flare committed to — and puts all three through the fold.
 *
 * If the recovery, the EIP-191 digest, the curve encoding or the leaf layout
 * were wrong anywhere, this is where it shows.
 */

const fixtures: Record<string, { calldata: Hex }> = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../shared/test/fixtures/relayCalldata.json', import.meta.url)),
    'utf8',
  ),
);

let calls: RelayCall[];
let known: PolicyKey[];

beforeAll(async () => {
  await RelayMessage.compile({ proofsEnabled: false });
  await SigningPolicyFold.compile({ proofsEnabled: false });
  calls = Object.values(fixtures).map((f) => parseRelayCalldata(f.calldata));
  known = (await harvestPolicyKeys(calls[0]!.policy, calls)).known;
}, 600_000);

describe('the policy tree', () => {
  it('places every known voter at its own policy index', () => {
    const tree = buildPolicyTree(known);
    // A witness taken at the index must reproduce the root, which is only true
    // if the leaf really sits there — packing voters into free slots would not.
    for (const voter of known) {
      expect(tree.witnessFor(voter.index).calculateIndex().toBigInt()).toBe(BigInt(voter.index));
    }
    expect(tree.provableWeight).toBe(known.reduce((s, v) => s + v.weight, 0));
  });

  it('changes root when a weight changes', () => {
    const a = buildPolicyTree(known);
    const b = buildPolicyTree(known.map((v, i) => (i === 0 ? { ...v, weight: v.weight + 1 } : v)));
    expect(a.root.toString()).not.toBe(b.root.toString());
  });

  it('rejects a key that is not an uncompressed point', () => {
    expect(() => toSecp256k1('0x02abcdef')).toThrow(/uncompressed/);
  });

  /**
   * The whole return path's first half, on real data: a signature Flare's
   * validators produced, verified against a key recovered from it, proven to
   * belong to the policy Flare's own contract commits to.
   */
  it('verifies a real validator signature against the committed policy', async () => {
    const call = calls[0]!;
    const tree = buildPolicyTree(known);
    const digest = signedMessageHash(call.message);

    // Any signature whose signer we managed to recover a key for.
    const signature = call.signatures.find((s) => known.some((k) => k.index === s.index))!;
    const voter = known.find((k) => k.index === signature.index)!;

    // The digest comes from the circuit, not from the helper: this is where
    // the two must agree, because a real validator signature is about to be
    // verified against it.
    const { proof: round } = await RelayMessage.bind(
      Bytes38.fromHex(call.message.encoded.slice(2)),
    );
    expect(round.publicOutput.digest.toHex()).toBe(digest.slice(2));

    const { proof } = await SigningPolicyFold.single(
      round,
      tree.root,
      new SignerInput({
        publicKey: toSecp256k1(voter.publicKey),
        signature: EcdsaSignature.from({ r: BigInt(signature.r), s: BigInt(signature.s) }),
        index: UInt32.from(voter.index),
        weight: UInt32.from(voter.weight),
        witness: tree.witnessFor(voter.index),
      }),
    );

    expect(proof.publicOutput.count.toString()).toBe('1');
    expect(proof.publicOutput.weight.toString()).toBe(String(voter.weight));
    expect(proof.publicOutput.policy.toString()).toBe(tree.root.toString());
  }, 600_000);

  /**
   * Merging real signatures is what actually clears Flare's threshold, and the
   * ascending-index rule is what keeps the summed weight honest.
   */
  it('merges real signatures up to Flare\'s threshold', async () => {
    const call = calls[0]!;
    const tree = buildPolicyTree(known);
    const { proof: round } = await RelayMessage.bind(
      Bytes38.fromHex(call.message.encoded.slice(2)),
    );

    const usable = call.signatures
      .filter((s) => known.some((k) => k.index === s.index))
      .sort((a, b) => a.index - b.index);

    let merged;
    for (const signature of usable) {
      const voter = known.find((k) => k.index === signature.index)!;
      const { proof } = await SigningPolicyFold.single(
        round,
        tree.root,
        new SignerInput({
          publicKey: toSecp256k1(voter.publicKey),
          signature: EcdsaSignature.from({ r: BigInt(signature.r), s: BigInt(signature.s) }),
          index: UInt32.from(voter.index),
          weight: UInt32.from(voter.weight),
          witness: tree.witnessFor(voter.index),
        }),
      );
      merged = merged === undefined ? proof : (await SigningPolicyFold.merge(merged, proof)).proof;
    }

    expect(Number(merged!.publicOutput.count.toString())).toBe(usable.length);
    expect(Number(merged!.publicOutput.weight.toString())).toBeGreaterThanOrEqual(
      call.policy.threshold,
    );
  }, 900_000);
});
