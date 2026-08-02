/**
 * How expensive is it to verify a Flare Relay signature inside a Mina zkApp?
 *
 * This measures the return path's core cost. Flare's attestation layer publishes
 * Merkle roots signed by a weighted validator set using secp256k1 ECDSA, so
 * proving a Flare event on Mina reduces to verifying those signatures plus a
 * Merkle proof — no recursive SNARK verification required.
 *
 * Run: node bench/ecdsaConstraints.mjs
 */
import { createForeignCurve, createEcdsa, Crypto, ZkProgram, Bytes } from 'o1js';

class Secp256k1 extends createForeignCurve(Crypto.CurveParams.Secp256k1) {}
class EcdsaSig extends createEcdsa(Secp256k1) {}
class Message32 extends Bytes(32) {}

// One Relay signature check: verify an ECDSA signature over a 32-byte message.
const OneSig = ZkProgram({
  name: 'one-relay-signature',
  methods: {
    verify: {
      privateInputs: [Message32, EcdsaSig, Secp256k1],
      async method(msg, sig, pk) {
        sig.verifySignedHash(msg, pk).assertTrue();
      },
    },
  },
});

const cs = await OneSig.analyzeMethods();
const rows = cs.verify.rows ?? cs.verify.gates?.length;
console.log('constraints for ONE secp256k1 ECDSA verify:', rows);
