import { Bytes, Field, Keccak, Struct, UInt32, ZkProgram } from 'o1js';

/**
 * Binds a validator signature to what it actually says.
 *
 * `SigningPolicyFold` proves enough weight signed a 32-byte digest — but a
 * digest is opaque, so on its own it establishes that Flare's validators signed
 * *something*. Nothing tied that something to the state being published, which
 * is why an admin co-signature stood in for the missing half.
 *
 * This closes it. Given the 38-byte protocol message, it recomputes the digest
 * exactly as a Flare validator does and exposes what the message says: which
 * protocol, which voting round, and the Merkle root of that round. A consumer
 * that requires `SignatureSet.message == RelayCommitment.digest` then knows the
 * validators signed *this* round with *this* root, and can go on to prove its
 * own data sits under that root.
 *
 * Two keccak blocks, ~29k rows — about one ECDSA. Cheap for what it removes.
 */

export class Bytes32 extends Bytes(32) {}

/** `1 protocolId | 4 votingRoundId | 1 isSecureRandom | 32 merkleRoot`. */
export class Bytes38 extends Bytes(38) {}

/** The EIP-191 preimage: 28-byte prefix followed by the inner hash. */
export class Bytes60 extends Bytes(60) {}

/**
 * `"\x19Ethereum Signed Message:\n32"`.
 *
 * Flare's validators sign the *prefixed* digest, not the message hash — a
 * signature recovered against the bare hash yields a different key and the
 * policy check fails, which is how this was found the first time.
 */
const EIP191_PREFIX = [
  0x19, 0x45, 0x74, 0x68, 0x65, 0x72, 0x65, 0x75, 0x6d, 0x20, 0x53, 0x69, 0x67, 0x6e,
  0x65, 0x64, 0x20, 0x4d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x3a, 0x0a, 0x33, 0x32,
];

/** FDC's protocol id. Its rounds are the ones carrying attestation roots. */
export const FDC_PROTOCOL_ID = 200;

export class RelayCommitment extends Struct({
  /** What a validator's signature is over. Matched against `SignatureSet.message`. */
  digest: Bytes32,
  protocolId: UInt32,
  votingRoundId: UInt32,
  /** Root of that round. What an inclusion proof must climb to. */
  merkleRoot: Bytes32,
}) {}

/** Big-endian bytes to a field. Used for the two small headers only. */
function beToField(bytes: { value: Field }[]): Field {
  return bytes.reduce((acc, b) => acc.mul(256).add(b.value), Field(0));
}

export const RelayMessage = ZkProgram({
  name: 'flare-relay-message',
  publicOutput: RelayCommitment,

  methods: {
    /**
     * Recompute the signed digest from the message, and say what it commits to.
     *
     * No merge method: a round has exactly one message, so there is nothing to
     * combine. The whole program is one call.
     */
    bind: {
      privateInputs: [Bytes38],
      async method(message: Bytes38) {
        // Exactly `hashMessage(keccak256(encoded))` — see `signedMessageHash`
        // in packages/shared, which both sides are pinned to.
        const inner = Keccak.ethereum(message);
        const digest = Bytes32.from(
          Keccak.ethereum(Bytes60.from([...EIP191_PREFIX, ...inner.bytes])).bytes,
        );

        const b = message.bytes;
        return {
          publicOutput: new RelayCommitment({
            digest,
            protocolId: UInt32.Unsafe.fromField(b[0]!.value),
            // Four bytes, so the product cannot approach the field modulus.
            votingRoundId: UInt32.Unsafe.fromField(beToField(b.slice(1, 5))),
            merkleRoot: Bytes32.from(b.slice(6, 38)),
          }),
        };
      },
    },
  },
});

export class RelayMessageProof extends ZkProgram.Proof(RelayMessage) {}
