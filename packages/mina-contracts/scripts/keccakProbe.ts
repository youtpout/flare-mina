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
 * Minimal reproduction of the one thing blocking the trustless return path.
 *
 * To finish the path, Mina has to hash the FDC attestation response and prove
 * the resulting leaf sits under the round's Merkle root. Everything else is
 * done: the attestation request lands on Coston2, the DA layer serves the
 * response and its proof, the leaf climbs to the root the Relay contract
 * stores, and `SigningPolicyFold` already proves the validator set signed that
 * round. What is missing is hashing 1344 bytes *inside a proof*.
 *
 * # What this measures
 *
 * 1344 bytes is 10 keccak blocks of 136, and o1js charges ~14,940 rows a block:
 *
 *     hashLeaf -> 149399 rows
 *
 * That is past the 65,536 of a single chunk. `numChunks: 3` should cover it,
 * and then Pickles refuses on the wrap domain instead:
 *
 *     This circuit was compiled for proofs using the wrap domain of size 13,
 *     but the actual wrap domain size for the circuit has size 14.
 *     You should pass the ~override_wrap_domain argument …
 *
 * `overrideWrapDomain` is exactly that argument, and it accepts 0 | 1 | 2 — but
 * all three produce the identical message, so it is not reaching the chunked
 * path. That is the wall.
 *
 * # The way around, if nobody finds a flag
 *
 * The sponge is sequential, so it cannot be merged — but it can be *chained*.
 * o1js keeps `permutation` and `absorb` internal (only `Keccak` is exported),
 * yet every primitive they need is public in `Gadgets`: `rotate64`, `xor`,
 * `and`, `not`. So the permutation can be vendored (~150 lines, MIT) and one
 * 136-byte block absorbed per proof, carrying the 25-lane state through the
 * public output. Ten proofs of ~15,000 rows each, which is a size this project
 * already compiles happily — `MerkleInclusion.level` is 14,733.
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

  const rows = (await Probe.analyzeMethods()).hashLeaf.rows;
  console.log(`rows            : ${rows}`);
  console.log(`blocks          : ${Math.ceil(RESPONSE_BYTES / 136)} of 136 bytes`);
  console.log(`per block       : ~${Math.round(rows / Math.ceil(RESPONSE_BYTES / 136))}`);
  console.log(`single-chunk max: 65536\n`);

  for (const numChunks of [3, 4, 5, 8]) {
    for (const overrideWrapDomain of [0, 1, 2] as const) {
      const label = `chunks=${numChunks} domain=${overrideWrapDomain}`;
      try {
        const started = Date.now();
        await Probe.compile({ numChunks, overrideWrapDomain, cache: Cache.None });
        console.log(`OK   ${label}  compiled in ${((Date.now() - started) / 1000).toFixed(1)}s`);

        const t = Date.now();
        const { proof } = await Probe.hashLeaf(Response.from(new Uint8Array(RESPONSE_BYTES).fill(7)));
        console.log(`     proved in ${((Date.now() - t) / 1000).toFixed(1)}s`);
        console.log(`     first byte of digest: ${proof.publicOutput.firstByte}`);
        return;
      } catch (e) {
        console.log(`fail ${label}  ${(e as Error).message.split('\n')[0].slice(0, 110)}`);
      }
    }
  }

  console.log('\nno combination compiled — see the note at the top of this file');
}

await main();
