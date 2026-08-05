import { hashMessage, keccak256, recoverPublicKey, toBytes, type Hex } from 'viem';

/**
 * Reads Flare's validator signatures out of a `Relay.relay()` transaction —
 * the only place they exist, since Relay stores just the root. `relay()`
 * declares no arguments and reads calldata in assembly, hence the layout below.
 *
 *   4 selector | 2 voters | 3 rewardEpoch | 4 startRound | 2 threshold | 32 seed
 *   per voter: 20 address + 2 weight
 *   38 signed message: 1 protocolId | 4 round | 1 isSecureRandom | 32 root
 *   2 signature count | per signature: 1 v + 32 r + 32 s + 2 signer index
 */

/** One entry of Flare's signing policy. */
export type PolicyVoter = {
  index: number;
  address: Hex;
  weight: number;
};

export type SigningPolicy = {
  rewardEpochId: number;
  startVotingRoundId: number;
  /** Weight that must sign before a root is accepted. */
  threshold: number;
  seed: Hex;
  voters: PolicyVoter[];
  /** The packed bytes, as `Relay` hashes them. Kept for `signingPolicyHash`. */
  encoded: Hex;
};

/** The 38 bytes the validators signed. */
export type ProtocolMessage = {
  protocolId: number;
  votingRoundId: number;
  isSecureRandom: boolean;
  merkleRoot: Hex;
  /** The signed bytes themselves, as they appear in calldata. */
  encoded: Hex;
};

export type RelaySignature = {
  v: number;
  r: Hex;
  s: Hex;
  /** Position in the signing policy. What the fold orders signatures by. */
  index: number;
};

export type RelayCall = {
  policy: SigningPolicy;
  message: ProtocolMessage;
  signatures: RelaySignature[];
};

/** FDC. Flare's other relayed protocol, 100, is FTSO scaling. */
export const FDC_PROTOCOL_ID = 200;

/** Cursor over calldata, in bytes rather than hex characters. */
class Reader {
  private at = 0;
  constructor(private readonly hex: string) {}

  take(bytes: number): string {
    const start = 2 + this.at * 2;
    this.at += bytes;
    if (this.at * 2 + 2 > this.hex.length) {
      throw new Error(`relay calldata ends mid-field at byte ${this.at}`);
    }
    return this.hex.slice(start, 2 + this.at * 2);
  }

  number(bytes: number): number {
    return parseInt(this.take(bytes), 16);
  }

  hexOf(bytes: number): Hex {
    return `0x${this.take(bytes)}`;
  }

  /** Re-read a stretch already consumed, for the signed message. */
  slice(fromByte: number, toByte: number): Hex {
    return `0x${this.hex.slice(2 + fromByte * 2, 2 + toByte * 2)}`;
  }

  get position(): number {
    return this.at;
  }

  get remaining(): number {
    return (this.hex.length - 2) / 2 - this.at;
  }
}

/** Decode a `Relay.relay()` transaction's calldata. */
export function parseRelayCalldata(calldata: Hex): RelayCall {
  const r = new Reader(calldata);
  r.take(4); // selector

  const policyStart = r.position;
  const voterCount = r.number(2);
  const rewardEpochId = r.number(3);
  const startVotingRoundId = r.number(4);
  const threshold = r.number(2);
  const seed = r.hexOf(32);

  const voters: PolicyVoter[] = [];
  for (let index = 0; index < voterCount; index++) {
    voters.push({ index, address: r.hexOf(20), weight: r.number(2) });
  }

  // Sliced verbatim rather than re-encoded: a drifting re-encoding would
  // silently recover the wrong signers.
  const policyEncoded = r.slice(policyStart, r.position);

  const messageStart = r.position;
  const protocolId = r.number(1);
  const votingRoundId = r.number(4);
  const isSecureRandom = r.number(1) !== 0;
  const merkleRoot = r.hexOf(32);
  const encoded = r.slice(messageStart, r.position);

  const signatureCount = r.number(2);
  if (r.remaining !== signatureCount * 67) {
    throw new Error(
      `relay calldata has ${r.remaining} trailing bytes, expected ${signatureCount * 67}`,
    );
  }

  const signatures: RelaySignature[] = [];
  for (let i = 0; i < signatureCount; i++) {
    signatures.push({
      v: r.number(1),
      r: r.hexOf(32),
      s: r.hexOf(32),
      index: r.number(2),
    });
  }

  return {
    policy: {
      rewardEpochId,
      startVotingRoundId,
      threshold,
      seed,
      voters,
      encoded: policyEncoded,
    },
    message: { protocolId, votingRoundId, isSecureRandom, merkleRoot, encoded },
    signatures,
  };
}

/**
 * The EIP-191 prefixed digest, not `keccak(message)` — which is the natural
 * guess, recovers successfully, and yields entirely wrong addresses. Found by
 * checking recovered signers against the policy, which is why that test exists.
 */
export function signedMessageHash(message: ProtocolMessage): Hex {
  return hashMessage({ raw: toBytes(keccak256(message.encoded)) });
}

/** Recover each signer's public key. The circuit needs keys; the policy only has addresses. */
export async function recoverSigners(
  message: ProtocolMessage,
  signatures: RelaySignature[],
): Promise<Array<{ index: number; publicKey: Hex }>> {
  const hash = signedMessageHash(message);
  return Promise.all(
    signatures.map(async ({ v, r, s, index }) => ({
      index,
      publicKey: await recoverPublicKey({
        hash,
        signature: { r, s, v: BigInt(v) },
      }),
    })),
  );
}

/** Last 20 bytes of keccak of the uncompressed key, minus its 0x04 prefix. */
export function addressFromPublicKey(publicKey: Hex): Hex {
  return `0x${keccak256(`0x${publicKey.slice(4)}`).slice(-40)}`;
}

/** A validator whose public key has been recovered. */
export type PolicyKey = PolicyVoter & { publicKey: Hex };

/**
 * Collect public keys from relay history. A key is only knowable once its voter
 * signs, and FTSO rounds land every 90s, so a short walk back covers the weight
 * that matters. Each key is kept only if it hashes to the policy's address.
 */
export async function harvestPolicyKeys(
  policy: SigningPolicy,
  calls: RelayCall[],
): Promise<{ known: PolicyKey[]; missing: PolicyVoter[] }> {
  const keys = new Map<number, Hex>();

  for (const call of calls) {
    // Another epoch is another validator set; its indices mean something else.
    if (call.policy.rewardEpochId !== policy.rewardEpochId) continue;

    for (const { index, publicKey } of await recoverSigners(call.message, call.signatures)) {
      const voter = policy.voters[index];
      if (voter === undefined) continue;
      if (addressFromPublicKey(publicKey).toLowerCase() !== voter.address.toLowerCase()) continue;
      keys.set(index, publicKey);
    }
  }

  const known: PolicyKey[] = [];
  const missing: PolicyVoter[] = [];
  for (const voter of policy.voters) {
    const publicKey = keys.get(voter.index);
    if (publicKey === undefined) missing.push(voter);
    else known.push({ ...voter, publicKey });
  }
  return { known, missing };
}

/** Weight represented by the voters whose keys are known. */
export function knownWeight(known: PolicyKey[]): number {
  return known.reduce((sum, v) => sum + v.weight, 0);
}

/**
 * The commitment Relay stores for an epoch — what makes a policy authoritative
 * rather than merely present. Not a keccak of the buffer: the first 64 bytes
 * are hashed, then each following 32-byte word is folded in, last one padded.
 */
export function signingPolicyHash(policy: SigningPolicy): Hex {
  const bytes = policy.encoded.slice(2);
  let hash = keccak256(`0x${bytes.slice(0, 128)}`);

  for (let at = 128; at < bytes.length; at += 64) {
    const word = bytes.slice(at, at + 64).padEnd(64, '0');
    hash = keccak256(`0x${hash.slice(2)}${word}`);
  }
  return hash;
}
