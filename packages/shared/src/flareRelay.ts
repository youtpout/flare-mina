import { hashMessage, keccak256, recoverPublicKey, toBytes, type Hex } from 'viem';

/**
 * Reads Flare's validator signatures out of a `Relay.relay()` transaction.
 *
 * # Where the signatures live
 *
 * Nowhere convenient. `Relay` stores only the Merkle root — the signatures that
 * justified it are never written to storage and never emitted in an event. They
 * exist in exactly one place: the **calldata of the transaction that finalised
 * the round**.
 *
 * So retrieving them means finding the `ProtocolMessageRelayed` log for the
 * round, fetching its transaction, and decoding a hand-packed byte layout.
 * There is no ABI for it: `relay()` takes no declared arguments and reads
 * calldata directly in assembly, because at ~100 voters the ABI overhead is
 * worth removing.
 *
 * # The layout
 *
 * ```
 *   4  selector
 *   2  number of voters
 *   3  reward epoch id
 *   4  first voting round of the epoch
 *   2  threshold
 *  32  random seed
 *      per voter:  20 address + 2 weight
 *   1  protocol id          <- the signed message starts here, 38 bytes
 *   4  voting round id
 *   1  isSecureRandom
 *  32  merkle root
 *   2  number of signatures
 *      per signature: 1 v + 32 r + 32 s + 2 signer index
 * ```
 *
 * Verified against a real Coston2 transaction: 8 voters, 3 signatures, and a
 * 201-byte tail — exactly 3 x 67.
 *
 * # Why this is the right shape for the Mina side
 *
 * Three things fall out of one transaction, and `SigningPolicyFold` needs all
 * three: the signatures, the signer indices it orders them by, and the voter
 * set with weights that the Poseidon policy tree is built from. Nothing has to
 * be reconciled across sources.
 *
 * What it does *not* give directly is public keys — the policy holds addresses,
 * which are hashes. Recovering them from the signatures is not a workaround but
 * the only route, and it is self-checking: a recovered key that hashes to the
 * address the policy lists at that index is the right key, and one that does
 * not means the message hash was wrong.
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

  const voterCount = r.number(2);
  const rewardEpochId = r.number(3);
  const startVotingRoundId = r.number(4);
  const threshold = r.number(2);
  const seed = r.hexOf(32);

  const voters: PolicyVoter[] = [];
  for (let index = 0; index < voterCount; index++) {
    voters.push({ index, address: r.hexOf(20), weight: r.number(2) });
  }

  // The signed message is these 38 bytes verbatim, so remember where it starts
  // rather than re-encoding it — a re-encoding that drifts would produce a hash
  // that recovers the wrong signers, silently.
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
    policy: { rewardEpochId, startVotingRoundId, threshold, seed, voters },
    message: { protocolId, votingRoundId, isSecureRandom, merkleRoot, encoded },
    signatures,
  };
}

/**
 * What the validators actually signed.
 *
 * Not the keccak of the message, which is the natural guess and is wrong.
 * Flare's providers sign it as a personal message, so the digest carries the
 * EIP-191 prefix:
 *
 *   keccak256("\x19Ethereum Signed Message:\n32" || keccak256(message))
 *
 * Determined by recovery rather than by reading: only this variant yields keys
 * whose addresses match the policy. The other two candidates recover
 * successfully and produce plausible, entirely wrong addresses — which is why
 * the test checks recovered signers against the policy rather than checking
 * that recovery merely succeeded.
 *
 * It also costs the Mina side a second keccak: binding the signed digest back
 * to the Merkle root means reproducing both hashes in circuit.
 */
export function signedMessageHash(message: ProtocolMessage): Hex {
  return hashMessage({ raw: toBytes(keccak256(message.encoded)) });
}

/**
 * Recover the secp256k1 public key behind each signature.
 *
 * The Mina circuit verifies against public keys; Flare's policy lists
 * addresses, which are truncated hashes of them. Recovery is the only way
 * across, and the caller should check each result against the address the
 * policy holds at that index — see `recoveredAddressMatches`.
 */
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

/**
 * The address a recovered public key corresponds to.
 *
 * Last 20 bytes of the keccak of the uncompressed key without its 0x04 prefix —
 * the standard derivation, spelled out here so the check against Flare's policy
 * is visible rather than delegated.
 */
export function addressFromPublicKey(publicKey: Hex): Hex {
  return `0x${keccak256(`0x${publicKey.slice(4)}`).slice(-40)}`;
}

/**
 * A validator, once its public key is known.
 *
 * The policy Flare publishes holds addresses. The Mina circuit verifies
 * signatures against public keys, and an address is a hash of one — so the key
 * cannot be read out of the policy, only recovered from a signature the voter
 * produced.
 */
export type PolicyKey = PolicyVoter & { publicKey: Hex };

/**
 * Collect public keys for a signing policy from relay transactions.
 *
 * # Why this is not just a lookup
 *
 * A voter's key becomes knowable only when they sign. In practice that is not
 * a limitation: FTSO rounds finalise every 90 seconds, so any voter carrying
 * weight signs constantly, and a short walk back through `Relay` history
 * surfaces every one of them. A voter who never signs has no key here, and also
 * contributes no weight to any threshold — so nothing is lost by not having it.
 *
 * # Why the result can be trusted
 *
 * Each recovered key is kept only if it hashes to the address the policy lists
 * at that index. That check is what binds a recovered key to Flare's own
 * commitment: a wrong message hash, a corrupted signature or a mismatched
 * calldata offset all recover *some* key, and all of them fail this.
 *
 * What is still assumed is that `policy` is genuine. It is, when it came from a
 * relay transaction that succeeded: `Relay.relay()` hashes the policy in its
 * calldata against `toSigningPolicyHash[rewardEpochId]` and reverts otherwise.
 */
export async function harvestPolicyKeys(
  policy: SigningPolicy,
  calls: RelayCall[],
): Promise<{ known: PolicyKey[]; missing: PolicyVoter[] }> {
  const keys = new Map<number, Hex>();

  for (const call of calls) {
    // A different reward epoch is a different validator set; its indices mean
    // something else and must not be mixed in.
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
