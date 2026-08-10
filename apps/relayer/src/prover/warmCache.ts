import { initializeBindings, setBackend } from 'o1js';
import { chunkedCache } from './cache.js';

/**
 * Fill the proving-key cache, so the relayer does not compile on its first tick.
 *
 * Run once after a deploy, before starting the service:
 *
 *   O1JS_CACHE_DIR=/var/lib/minaport/o1js-cache node dist/src/prover/warmCache.js
 *
 * A cold compile of every circuit is about four minutes, and `FdcLeaf` alone is
 * 158 s of it. Doing that inside the relayer means the first withdrawal after a
 * restart waits for it — and both prover lanes pay it separately, on the same
 * cores.
 *
 * Budget ~6.3 GB of disk, and run it with a large heap — reading that 2.6 GB key
 * back needs more than Node's default, and the failure is an OOM partway
 * through the restore rather than anything legible. `pnpm warm-cache` sets it.
 *
 * Native backend, not by preference: `FdcLeaf` at `numChunks: 4` needs a 2^18
 * domain, and the wasm build cannot hold its key.
 */

const CACHE_DIR = process.env.O1JS_CACHE_DIR;
if (CACHE_DIR === undefined) {
  console.error('O1JS_CACHE_DIR is not set; there would be nothing to warm');
  process.exit(1);
}

setBackend('native');
await initializeBindings();

const cache = chunkedCache(CACHE_DIR, true);
const options = { cache };

const { TransferChain } = await import('@minaport/mina-contracts/dist/src/TransferChain.js');
const { RelayMessage } = await import('@minaport/mina-contracts/dist/src/RelayMessage.js');
const { MerkleInclusion } = await import('@minaport/mina-contracts/dist/src/MerkleInclusion.js');
const { SigningPolicyFold } = await import(
  '@minaport/mina-contracts/dist/src/SigningPolicyFold.js'
);
const { FdcLeaf, FdcAttestation } = await import(
  '@minaport/mina-contracts/dist/src/FdcAttestation.js'
);
const { MinaPortBridge } = await import('@minaport/mina-contracts/dist/src/MinaPortBridge.js');
const { AssetPort } = await import('@minaport/mina-contracts/dist/src/AssetPort.js');
const { FungibleToken } = await import('mina-fungible-token');

// The token resolves its admin class through this, exactly as the worker does.
FungibleToken.AdminContract = AssetPort as never;

/** Same order as the worker: a program must exist before whatever verifies it. */
const programs: [string, { compile(o?: unknown): Promise<unknown> }][] = [
  ['TransferChain', TransferChain],
  ['RelayMessage', RelayMessage],
  ['MerkleInclusion', MerkleInclusion],
  ['SigningPolicyFold', SigningPolicyFold],
  ['FdcLeaf', FdcLeaf],
  ['FdcAttestation', FdcAttestation],
  ['MinaPortBridge', MinaPortBridge],
];

if (process.env.MINA_ASSET_PORTS) {
  programs.push(['AssetPort', AssetPort], ['FungibleToken', FungibleToken as never]);
}

const started = Date.now();
for (const [name, program] of programs) {
  const t = Date.now();
  await program.compile(options);
  console.log(`${name.padEnd(20)} ${((Date.now() - t) / 1000).toFixed(1).padStart(7)}s`);
}

console.log(`\ntotal ${((Date.now() - started) / 1000).toFixed(1)}s`);

// A second pass over the heaviest one, reading back what was just written. A
// cache that writes and cannot read is the failure this script exists to
// prevent, and it is invisible until the next restart.
const before = { ...cache.stats };
const verify = Date.now();
await FdcLeaf.compile(options);
const elapsed = (Date.now() - verify) / 1000;

// Counted, not timed. This was a 60 s threshold, and a re-read that took 85.7 s
// on a slower host — three times faster than that host's 255.6 s cold compile,
// so plainly a hit — was reported as a failure. A ratio would have been better
// and still a guess; the cache knows the answer.
const misses = cache.stats.misses - before.misses;
console.log(`FdcLeaf re-read ${elapsed.toFixed(1)}s, ${misses} cache miss(es)`);

if (misses > 0) {
  console.error(
    `\nFdcLeaf recompiled instead of loading from ${CACHE_DIR}. The cache is not ` +
      'being read back — check disk space and permissions before starting the relayer.',
  );
  process.exit(1);
}

console.log(`\ncache warm in ${CACHE_DIR}`);
