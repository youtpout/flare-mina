import { keccak256, type Hex } from 'viem';

/**
 * Reads an FDC `EVMTransaction` attestation response.
 *
 * This is the half of the trustless return path that runs off chain: it finds
 * the bridge event inside the attested response, and checks that the response
 * really is the one the Flare validators signed. The Mina circuit then redoes
 * both in-circuit — this module exists so the relayer can decide what to prove
 * before paying to prove it, and so the byte offsets have one definition that a
 * test pins against a real response.
 *
 * # Why the offsets are constants
 *
 * They are only stable because we control the request. Asking for
 * `provideInput: false` and a single `logIndices` entry produces a response of
 * exactly 42 words, with the event last. A wider request moves everything, so
 * {parseAttestedEvent} verifies the shape rather than trusting it.
 *
 * The saving is not cosmetic: the full response is 4064 bytes, which is 30
 * keccak blocks and about 440,000 constraints to hash. Trimmed it is 1344
 * bytes, 10 blocks, ~149,000. Same proof, a third of the work.
 */

/** 32-byte words, which is how ABI encoding lays everything out. */
const WORD = 32;

/** Word indices in a trimmed `EVMTransaction` response. Pinned by test. */
const OFFSETS = {
  /** Contract that emitted the event. */
  emitter: 28,
  /** Event signature. */
  topic0: 33,
  /** The transfer's index in the chain — the first indexed argument. */
  topic1: 34,
  /** The asset. */
  topic2: 35,
  /** First word of the event's non-indexed data. */
  dataStart: 38,
} as const;

/** Total words in a trimmed response. A different count means a different shape. */
const EXPECTED_WORDS = 42;

export type AttestedEvent = {
  /** Address that emitted it, lowercase. */
  emitter: Hex;
  /** Indexed arguments, in order. */
  topics: Hex[];
  /** Non-indexed arguments, one per word. */
  data: Hex[];
  /**
   * Last word of the event data: the chain head this transfer produced.
   *
   * One event for every asset now — `TransferChain.Transfer` — so this decoder
   * serves the escrow and every port from a single attestation.
   */
  newActionState: bigint;
};

function wordAt(response: Hex, index: number): Hex {
  const start = 2 + index * WORD * 2;
  return `0x${response.slice(start, start + WORD * 2)}`;
}

/**
 * Pull the bridge event out of an attested response.
 *
 * @param response the ABI-encoded response, exactly as the DA layer serves it
 * @param expected the emitter and event signature this caller will accept
 *
 * Throws rather than returning null: every failure here means the request was
 * built wrong or the response is not the one asked for, and both are bugs
 * rather than conditions to handle.
 */
export function parseAttestedEvent(
  response: Hex,
  expected: { emitter: Hex; topic0: Hex },
): AttestedEvent {
  const words = (response.length - 2) / (WORD * 2);
  if (words !== EXPECTED_WORDS) {
    throw new Error(
      `expected a trimmed response of ${EXPECTED_WORDS} words, got ${words} — ` +
        'the request must set provideInput false and name exactly one logIndex',
    );
  }

  const emitter = `0x${wordAt(response, OFFSETS.emitter).slice(26)}` as Hex;
  if (emitter.toLowerCase() !== expected.emitter.toLowerCase()) {
    throw new Error(`event came from ${emitter}, expected ${expected.emitter}`);
  }

  const topic0 = wordAt(response, OFFSETS.topic0);
  if (topic0.toLowerCase() !== expected.topic0.toLowerCase()) {
    throw new Error(`event signature ${topic0} is not the expected one`);
  }

  const topics = [topic0, wordAt(response, OFFSETS.topic1), wordAt(response, OFFSETS.topic2)];
  const data: Hex[] = [];
  for (let i = OFFSETS.dataStart; i < EXPECTED_WORDS; i++) data.push(wordAt(response, i));

  return {
    emitter,
    topics,
    data,
    // The last word. Its position is what the circuit will read, so it is
    // derived here the same way rather than by name.
    newActionState: BigInt(wordAt(response, EXPECTED_WORDS - 1)),
  };
}

/**
 * The leaf an FDC round commits to: keccak over the response, verbatim.
 *
 * Not over any re-encoding of it — the DA layer serves the exact bytes the
 * attestation providers agreed on, and re-encoding them would produce a leaf
 * that is not in the tree.
 */
export function attestationLeaf(response: Hex): Hex {
  return keccak256(response);
}

/**
 * Climb a Merkle proof to the round root.
 *
 * Sorted pairs, which is what Flare uses and what OpenZeppelin's verifier
 * expects. An implementation that carried a left/right flag instead would
 * compute a different root from the same path — and that is precisely the bug
 * currently sitting in the Mina-side `MerkleInclusion`.
 */
export function climbToRoot(leaf: Hex, proof: Hex[]): Hex {
  let node = leaf;
  for (const sibling of proof) {
    const [a, b] =
      node.toLowerCase() < sibling.toLowerCase() ? [node, sibling] : [sibling, node];
    node = keccak256(`0x${a.slice(2)}${b.slice(2)}`);
  }
  return node;
}

/**
 * Everything the relayer needs before it decides to prove.
 *
 * @param root the round root, read from `Relay.merkleRoots(200, votingRoundId)`
 */
export function verifyAttestation(
  response: Hex,
  proof: Hex[],
  root: Hex,
  expected: { emitter: Hex; topic0: Hex },
): AttestedEvent {
  const climbed = climbToRoot(attestationLeaf(response), proof);
  if (climbed.toLowerCase() !== root.toLowerCase()) {
    throw new Error(`proof climbs to ${climbed}, not to the round root ${root}`);
  }
  return parseAttestedEvent(response, expected);
}
