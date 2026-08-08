import { Cache, setBackend, initializeBindings } from 'o1js';
import { mkdtempSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const backend = process.argv[2];               // 'native' | 'wasm'
if (backend === 'native') setBackend('native');
await initializeBindings();

const { MerkleInclusion } = await import('./dist/src/MerkleInclusion.js');
const { FdcLeaf } = await import('./dist/src/FdcAttestation.js');
const { keccak256, concatHex } = await import('viem');

const dir = mkdtempSync(join(tmpdir(), `o1js-${backend}-`));
const cache = Cache.FileSystem(dir);
const sec = (t) => ((Date.now() - t) / 1000).toFixed(1);

let t = Date.now();
await MerkleInclusion.compile({ cache });
console.log(`${backend}  compile MerkleInclusion  ${sec(t).padStart(6)}s`);

const { Bytes32 } = await import('./dist/src/MerkleInclusion.js');
const h = (i) => keccak256(`0x${i.toString(16).padStart(64, '0')}`);
const b32 = (x) => Bytes32.fromHex(x.slice(2));
t = Date.now();
await MerkleInclusion.levels4(b32(h(1)), b32(h(2)), b32(h(3)), b32(h(4)), b32(h(5)));
console.log(`${backend}  prove levels4            ${sec(t).padStart(6)}s`);

t = Date.now();
try {
  await FdcLeaf.compile({ cache });
  console.log(`${backend}  compile FdcLeaf          ${sec(t).padStart(6)}s`);
} catch (e) {
  console.log(`${backend}  compile FdcLeaf          ECHEC: ${String(e.message).slice(0, 70)}`);
}

let total = 0;
const sizes = [];
for (const f of readdirSync(dir)) {
  const s = statSync(join(dir, f)).size;
  total += s;
  if (f.startsWith('step-pk') || f.startsWith('wrap-pk')) sizes.push([f, s]);
}
console.log(`${backend}  cache total              ${(total / 1e9).toFixed(2)} Go`);
for (const [f, s] of sizes.sort((a, b) => b[1] - a[1]).slice(0, 4))
  console.log(`${backend}    ${String(s).padStart(12)}  ${f}`);
rmSync(dir, { recursive: true, force: true });
