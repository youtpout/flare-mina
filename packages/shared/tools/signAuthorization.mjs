/**
 * Sign a MinaAccount action with a real Mina key.
 *
 * Invoked by the Foundry suite through FFI so the on-chain verifier is tested
 * against signatures produced by the reference library at run time, rather than
 * against constants pasted into a test file that could drift.
 *
 * Usage: node signAuthorization.mjs <account> <target> <value> <calldata> <nonce> <chainId>
 * Prints a JSON object; Foundry reads it with `vm.parseJson`.
 */
import { keccak256, encodeAbiParameters } from 'viem';
import { PublicKey as O1PublicKey, PrivateKey as O1PrivateKey } from 'o1js';

const base =
  '/Users/eddy/Projects/flare-mina/node_modules/.pnpm/mina-signer@4.1.0/node_modules/mina-signer/dist/node/mina-signer/src';
const { sign, verify } = await import(base + '/signature.js');
const { PrivateKey } = await import(base + '/curve-bigint.js');

// Fixed demo key. Never used for anything holding value.
const SECRET = 'EKFMDY6zupggg3uoLkkRnqaeS1oBN3WGfU6MDqXcvJMBhcmhpCk4';

const [account, target, value, calldata, nonce, chainId] = process.argv.slice(2);

const sk = PrivateKey.fromBase58(SECRET);
const pub = PrivateKey.toPublicKey(sk);
const group = O1PrivateKey.fromBase58(SECRET).toPublicKey().toGroup();

// actionHash = keccak256(abi.encode(target, value, keccak256(data)))
const actionHash = keccak256(
  encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
    [target, BigInt(value), keccak256(calldata)],
  ),
);

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
