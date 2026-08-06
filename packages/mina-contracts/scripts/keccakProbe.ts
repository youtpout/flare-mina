import {
  Bytes,
  Cache,
  Field,
  Keccak,
  Struct,
  ZkProgram,
  initializeBindings,
  setBackend,
} from 'o1js';

/**
 * What it costs to hash an FDC attestation response inside a proof.
 *
 * To finish the path, Mina has to hash the FDC attestation response and prove
 * the resulting leaf sits under the round's Merkle root. Everything else is
 * done: the attestation request lands on Coston2, the DA layer serves the
 * response and its proof, the leaf climbs to the root the Relay contract
 * stores, and `SigningPolicyFold` already proves the validator set signed that
 * round. What is missing is hashing 1344 bytes *inside a proof*.
 *
 * # The numbers
 *
 * 1344 bytes is 10 keccak blocks of 136, and o1js charges ~14,940 rows a block:
 *
 *     hashLeaf   149,399 rows
 *     compile     36.8 s
 *     prove       34.2 s
 *
 * That is well past the 65,536 rows of a single chunk, so the circuit has to be
 * split. **`numChunks` and `overrideWrapDomain` belong on the `ZkProgram`
 * declaration, not on `compile()`** — passing them to `compile()` type-errors,
 * and running the same call untyped silently ignores them, which reads exactly
 * like the flag having no effect. That cost an afternoon.
 *
 * `numChunks: 3` compiles and then fails to prove with `Expected 4 <= 3`;
 * `numChunks: 4, overrideWrapDomain: 2` compiles *and* proves, and is also
 * faster to compile than 3. The digest it produces matches viem's `keccak256`
 * byte for byte.
 *
 * So no vendored sponge is needed: one method hashes the whole response.
 *
 * Run it with:
 *   pnpm --filter @minaport/mina-contracts exec tsx scripts/keccakProbe.ts
 */

/** The trimmed FDC response: `provideInput: false`, one `logIndices` entry. */
const RESPONSE_BYTES = 1344;

class Response extends Bytes(RESPONSE_BYTES) {}
class Digest extends Struct({ firstByte: Field }) {}

const Probe = ZkProgram({
  name: 'keccak-probe',
  publicOutput: Digest,

  // On the declaration. `compile()` does not accept these.
  numChunks: 4,
  overrideWrapDomain: 2,

  methods: {
    hashLeaf: {
      privateInputs: [Response],
      async method(response: Response) {
        // `ethereum`, not `nistSha3`: Ethereum froze Keccak before NIST changed
        // the padding, and the two disagree on every input.
        const digest = Keccak.ethereum(response);
        return { publicOutput: new Digest({ firstByte: digest.bytes[0]!.value }) };
      },
    },
  },
});

async function main() {
  setBackend('native');
  await initializeBindings();

  const rows = (await Probe.analyzeMethods()).hashLeaf!.rows;
  const blocks = Math.ceil(RESPONSE_BYTES / 136);
  console.log(`rows      : ${rows}`);
  console.log(`blocks    : ${blocks} of 136 bytes (~${Math.round(rows / blocks)} each)`);
  console.log(`chunk max : 65536\n`);

  let t = Date.now();
  await Probe.compile({ cache: Cache.None });
  console.log(`compiled in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  t = Date.now();
  const { proof } = await Probe.hashLeaf(Response.from(new Uint8Array(RESPONSE_BYTES).fill(7)));
  console.log(`proved in   ${((Date.now() - t) / 1000).toFixed(1)}s`);

  // keccak256 of 1344 bytes of 0x07 is 0xafad7659…, so 175 is the check.
  console.log(`first byte  ${proof.publicOutput.firstByte} (expected 175)`);
}

await main();
