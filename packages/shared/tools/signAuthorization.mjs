/**
 * Sign a MinaAccount action with a real Mina key.
 *
 * Invoked by the Foundry suite through FFI so the on-chain verifier is tested
 * against signatures produced by the reference library at run time, rather than
 * against constants pasted into a test file that could drift.
 *
 * Usage:
 *   node signAuthorization.mjs <account> <target> <value> <calldata> <nonce> <chainId>
 *   node signAuthorization.mjs --batch <account> <nonce> <chainId> <t1> <v1> <d1> [t2 v2 d2 ...]
 *   node signAuthorization.mjs --action <account> <actionHash> <nonce> <chainId>
 *
 * Prints a JSON object; Foundry reads it with `vm.parseJson`.
 */
import { keccak256, encodeAbiParameters, toHex } from 'viem';
import { PublicKey as O1PublicKey, PrivateKey as O1PrivateKey } from 'o1js';

const base =
  '/Users/eddy/Projects/flare-mina/node_modules/.pnpm/mina-signer@4.1.0/node_modules/mina-signer/dist/node/mina-signer/src';
const { sign, verify } = await import(base + '/signature.js');
const { PrivateKey } = await import(base + '/curve-bigint.js');

// Fixed demo key. Never used for anything holding value.
const SECRET = 'EKFMDY6zupggg3uoLkkRnqaeS1oBN3WGfU6MDqXcvJMBhcmhpCk4';

const argv = process.argv.slice(2);
const isBatch = argv[0] === '--batch';
const isRawAction = argv[0] === '--action';

const sk = PrivateKey.fromBase58(SECRET);
const pub = PrivateKey.toPublicKey(sk);
const group = O1PrivateKey.fromBase58(SECRET).toPublicKey().toGroup();

/** Commitment to a single call: keccak256(abi.encode(target, value, keccak256(data))). */
function callHash(target, value, data) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
      [target, BigInt(value), keccak256(data)],
    ),
  );
}

let account;
let nonce;
let chainId;
let actionHash;

if (isBatch) {
  // --batch <account> <nonce> <chainId> then (target, value, data) triples.
  [, account, nonce, chainId] = argv;
  const triples = argv.slice(4);
  if (triples.length === 0 || triples.length % 3 !== 0) {
    throw new Error('batch calls must be (target, value, data) triples');
  }

  const items = [];
  for (let i = 0; i < triples.length; i += 3) {
    items.push(callHash(triples[i], triples[i + 1], triples[i + 2]));
  }

  // Mirrors MinaAccount.batchHash: domain-separated so a one-call batch and a
  // lone call are different statements.
  const BATCH_DOMAIN = keccak256(toHex('MinaAccount.Batch.v1'));
  actionHash = keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32[]' }], [BATCH_DOMAIN, items]),
  );
} else if (isRawAction) {
  // --action <account> <actionHash> <nonce> <chainId>
  //
  // For callers that build their own action commitment — the bridge's deposit
  // intent, for instance — rather than committing to a call.
  [, account, actionHash, nonce, chainId] = argv;
} else {
  const [acct, target, value, calldata, n, cid] = argv;
  account = acct;
  nonce = n;
  chainId = cid;
  actionHash = callHash(target, value, calldata);
}

// The six-field authorization encoding: see MinaAuthRegistry.encodeAuthorization.
const ah = BigInt(actionHash);
const fields = [
  BigInt(chainId),
  BigInt(account),
  ah >> 128n,
  ah & ((1n << 128n) - 1n),
  BigInt(nonce),
  18446744073709551615n, // expiry: max, so the test never depends on the clock
];

const signature = sign({ fields }, sk, 'devnet');
if (!verify(signature, { fields }, pub, 'devnet')) {
  throw new Error('signature failed to self-verify');
}

const minaKey = pub.x | (pub.isOdd ? 1n << 255n : 0n);

process.stdout.write(
  JSON.stringify({
    minaKey: '0x' + minaKey.toString(16).padStart(64, '0'),
    pkX: '0x' + group.x.toBigInt().toString(16).padStart(64, '0'),
    pkY: '0x' + group.y.toBigInt().toString(16).padStart(64, '0'),
    isOdd: pub.isOdd,
    sigR: '0x' + signature.r.toString(16).padStart(64, '0'),
    sigS: '0x' + signature.s.toString(16).padStart(64, '0'),
    actionHash,
  }),
);
