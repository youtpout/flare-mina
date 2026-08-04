import { hexToBytes, sha256, type Hex } from 'viem';

/**
 * Mina base58check signature codec.
 *
 * # Why this exists
 *
 * Wallets do not agree on how to hand back a field signature. `mina-signer`
 * returns `{ field, scalar }` as decimal strings, which is what the Solidity
 * verifier wants. Auro returns a single base58check string. Code that assumes
 * the first shape fails against the second with `Cannot convert undefined to a
 * BigInt` — a message that says nothing about wallets, signatures, or
 * encodings, which is how it cost an afternoon.
 *
 * Layout of a decoded signature, 70 bytes, read off a real `mina-signer`
 * output rather than assumed:
 *
 *   [0]      base58check version byte for signatures = 0x9A (154)
 *   [1]      binary structure version                = 0x01
 *   [2..34)  field  (r), LITTLE-endian               (32 bytes)
 *   [34..66) scalar (s), LITTLE-endian               (32 bytes)
 *   [66..70) checksum = sha256(sha256(bytes[0..66]))[0..4]
 *
 * Same endianness flip as addresses: base58 is little-endian on the wire, and
 * everything crossing a chain boundary here is big-endian so Solidity and Rust
 * can treat it as a plain 256-bit word.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SIGNATURE_VERSION_BYTE = 0x9a;
const BINARY_VERSION = 0x01;
const DECODED_LENGTH = 70;
const PAYLOAD_LENGTH = 66;

function base58Decode(input: string): Uint8Array {
  let num = 0n;
  for (const char of input) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`invalid base58 character: ${char}`);
    num = num * 58n + BigInt(index);
  }

  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const char of input) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
  return value;
}

/** A signature in the form the Solidity verifier consumes. */
export type MinaFieldSignature = { field: bigint; scalar: bigint };

/** Decode a base58check Mina signature into its `(r, s)` scalars. */
export function parseMinaSignature(signature: string): MinaFieldSignature {
  const decoded = base58Decode(signature);
  if (decoded.length !== DECODED_LENGTH) {
    throw new Error(
      `invalid Mina signature length: ${decoded.length} (expected ${DECODED_LENGTH})`,
    );
  }
  if (decoded[0] !== SIGNATURE_VERSION_BYTE) {
    throw new Error(`invalid Mina signature version byte: ${decoded[0]}`);
  }
  if (decoded[1] !== BINARY_VERSION) {
    throw new Error(`unsupported Mina signature binary version: ${decoded[1]}`);
  }

  const payload = decoded.slice(0, PAYLOAD_LENGTH);
  const expected = hexToBytes(sha256(hexToBytes(sha256(payload)))).slice(0, 4);
  const actual = decoded.slice(PAYLOAD_LENGTH);
  for (let i = 0; i < 4; i++) {
    if (expected[i] !== actual[i]) throw new Error('invalid Mina signature checksum');
  }

  return {
    field: littleEndianToBigInt(decoded.slice(2, 34)),
    scalar: littleEndianToBigInt(decoded.slice(34, 66)),
  };
}

/**
 * Accept whatever shape a wallet returned.
 *
 * Deliberately permissive at the boundary and strict afterwards: a wrong
 * signature fails on chain against the Pallas curve, so guessing wrong here
 * costs a reverted transaction rather than anything worse. What it buys is
 * working with more than one wallet without asking which is installed.
 */
export function toFieldSignature(
  signature: string | { field: string | bigint; scalar: string | bigint } | undefined,
): MinaFieldSignature {
  if (signature === undefined) throw new Error('wallet returned no signature');
  if (typeof signature === 'string') return parseMinaSignature(signature);

  if (signature.field === undefined || signature.scalar === undefined) {
    throw new Error('wallet returned a signature without field/scalar');
  }
  return { field: BigInt(signature.field), scalar: BigInt(signature.scalar) };
}

/** Hex form, for logging and fixtures. */
export function signatureToHex(signature: MinaFieldSignature): { field: Hex; scalar: Hex } {
  const hex = (value: bigint): Hex => `0x${value.toString(16).padStart(64, '0')}`;
  return { field: hex(signature.field), scalar: hex(signature.scalar) };
}
