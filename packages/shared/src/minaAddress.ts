import { bytesToHex, hexToBytes, sha256, type Hex } from 'viem';
import { PALLAS_FIELD_ORDER } from './constants.js';
import type { MinaPublicKeyParts } from './types.js';

/**
 * Mina base58check address codec.
 *
 * Layout of a decoded "B62..." address (40 bytes total), verified empirically
 * against `o1js` `PublicKey.toBase58` output (see minaAddress.test.ts):
 *
 *   [0]      base58check version byte for public keys  = 0xCB (203)
 *   [1]      binary structure version                  = 0x01
 *   [2]      compressed curve point version            = 0x01
 *   [3..35)  field element x, LITTLE-endian            (32 bytes)
 *   [35]     isOdd flag                                = 0x00 | 0x01
 *   [36..40) checksum = sha256(sha256(bytes[0..36]))[0..4]
 *
 * Note the endianness flip: base58 stores `x` little-endian, while every
 * cross-chain structure in MinaPort stores it big-endian (`bytes32`), so that
 * Solidity and Rust can treat it as a plain 256-bit word. `parseMinaAddress`
 * and `formatMinaAddress` are the only places allowed to perform that flip.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MINA_PUBLIC_KEY_VERSION_BYTE = 0xcb;
const MINA_BINARY_VERSION = 0x01;
const MINA_POINT_VERSION = 0x01;
const DECODED_LENGTH = 40;
const PAYLOAD_LENGTH = 36;
const X_OFFSET = 3;
const IS_ODD_OFFSET = 35;

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
  // Leading '1' characters encode leading zero bytes.
  for (const char of input) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) num = (num << 8n) | BigInt(byte);

  let out = '';
  while (num > 0n) {
    const remainder = Number(num % 58n);
    out = BASE58_ALPHABET[remainder] + out;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

function checksum(payload: Uint8Array): Uint8Array {
  const first = hexToBytes(sha256(payload));
  const second = hexToBytes(sha256(first));
  return second.slice(0, 4);
}

/** Decode a "B62..." address into its canonical big-endian (x, isOdd) parts. */
export function parseMinaAddress(address: string): MinaPublicKeyParts {
  const decoded = base58Decode(address);
  if (decoded.length !== DECODED_LENGTH) {
    throw new Error(`invalid Mina address length: ${decoded.length} (expected ${DECODED_LENGTH})`);
  }
  if (decoded[0] !== MINA_PUBLIC_KEY_VERSION_BYTE) {
    throw new Error(`invalid Mina address version byte: ${decoded[0]}`);
  }
  if (decoded[1] !== MINA_BINARY_VERSION) {
    throw new Error(`unsupported Mina address binary version: ${decoded[1]}`);
  }
  if (decoded[2] !== MINA_POINT_VERSION) {
    throw new Error(`unsupported Mina curve point version: ${decoded[2]}`);
  }

  const payload = decoded.slice(0, PAYLOAD_LENGTH);
  const expected = checksum(payload);
  const actual = decoded.slice(PAYLOAD_LENGTH);
  for (let i = 0; i < 4; i++) {
    if (expected[i] !== actual[i]) throw new Error('invalid Mina address checksum');
  }

  const isOddByte = decoded[IS_ODD_OFFSET];
  if (isOddByte !== 0 && isOddByte !== 1) throw new Error('invalid Mina address isOdd flag');

  // little-endian on the wire -> big-endian bytes32
  const xLittleEndian = decoded.slice(X_OFFSET, X_OFFSET + 32);
  const xBigEndian = Uint8Array.from(xLittleEndian).reverse();

  return { x: bytesToHex(xBigEndian), isOdd: isOddByte === 1 };
}

/** Re-encode canonical (x, isOdd) parts back into a "B62..." address. */
export function formatMinaAddress(parts: MinaPublicKeyParts): string {
  const xBigEndian = hexToBytes(parts.x);
  if (xBigEndian.length !== 32) throw new Error('x must be exactly 32 bytes');
  const xLittleEndian = Uint8Array.from(xBigEndian).reverse();

  const payload = new Uint8Array(PAYLOAD_LENGTH);
  payload[0] = MINA_PUBLIC_KEY_VERSION_BYTE;
  payload[1] = MINA_BINARY_VERSION;
  payload[2] = MINA_POINT_VERSION;
  payload.set(xLittleEndian, X_OFFSET);
  payload[IS_ODD_OFFSET] = parts.isOdd ? 1 : 0;

  const full = new Uint8Array(DECODED_LENGTH);
  full.set(payload, 0);
  full.set(checksum(payload), PAYLOAD_LENGTH);
  return base58Encode(full);
}

/** True when `address` is a syntactically valid Mina public key. */
export function isValidMinaAddress(address: string): boolean {
  try {
    parseMinaAddress(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encode a Mina recipient for the Flare -> Mina direction.
 *
 * `MinaPortBridge.burnToMina` takes a single `bytes32 minaRecipient`, so the
 * isOdd bit has to travel somewhere. We store the field element `x` in the low
 * 255 bits and place isOdd in bit 255.
 *
 * A Pallas base field element is < 2^255, so bit 255 is always free and the
 * packing is lossless. This is exactly the scheme implemented by
 * `ZekoAddressLib.pack` (ethereum-settlement) and mirrored here by
 * `MinaAddressLib.pack` in packages/flare-contracts.
 */
export function encodeMinaRecipient(parts: MinaPublicKeyParts): Hex {
  const x = BigInt(parts.x);
  if (x >= PALLAS_FIELD_ORDER) throw new Error('x is not a valid Pallas field element');
  const packed = parts.isOdd ? x | (1n << 255n) : x;
  return `0x${packed.toString(16).padStart(64, '0')}` as Hex;
}

/** Inverse of `encodeMinaRecipient`. */
export function decodeMinaRecipient(recipient: Hex): MinaPublicKeyParts {
  const packed = BigInt(recipient);
  const isOdd = (packed >> 255n) === 1n;
  const x = packed & ((1n << 255n) - 1n);
  if (x >= PALLAS_FIELD_ORDER) throw new Error('x is not a valid Pallas field element');
  return { x: `0x${x.toString(16).padStart(64, '0')}` as Hex, isOdd };
}
