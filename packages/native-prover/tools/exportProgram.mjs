// Export the bridge zkApp's recorded circuits so Rust can prove them without
// o1js.
//
// o1js runs exactly once, here. It compiles `MinaPortBridge`, records every
// method branch, then runs one real `deposit` to capture that branch's solved
// witness. What comes out is a self-contained program the Rust prover can
// compile and prove against — no Node, no js_of_ocaml, no o1js at run time.
//
// The recordings arrive through `__rustPicklesRecordingObserver`, a hook the
// o1js fork calls for every circuit it records. It is a no-op when unset, so
// installing it costs nothing and changes no behaviour.
//
// Usage, from the repository root:
//   node packages/native-prover/tools/exportProgram.mjs [outfile]
//
// Requires the o1js fork (branch `pickle-rust`) resolved as `o1js`, plus its
// `@o1js/mina-runtime-<platform>-<arch>` addon. See README.md.

import { writeFile } from 'node:fs/promises';
import {
  setBackend,
  setProofSystemBackend,
  initializeBindings,
  AccountUpdate,
  Cache,
  Mina,
  PrivateKey,
  UInt64,
} from 'o1js';

setBackend('native');
setProofSystemBackend('rust');
await initializeBindings();

const { MinaPortBridge, flareRecipientField } = await import(
  '@minaport/mina-contracts/dist/src/MinaPortBridge.js'
);

const outPath = process.argv[2] ?? new URL('../assets/bridge-program.json', import.meta.url).pathname;

/** Every circuit the fork records, in the order it records them. */
const recordings = [];
globalThis.__rustPicklesRecordingObserver = (recording) => recordings.push(recording);

// ---------------------------------------------------------------------------
// 1. Compile — one recording per method branch, in declaration order.
// ---------------------------------------------------------------------------

const compileStart = Date.now();
const { verificationKey } = await MinaPortBridge.compile({ cache: Cache.FileSystemDefault });
const compileMs = Date.now() - compileStart;

const branches = recordings.splice(0, recordings.length);
if (branches.length === 0) throw Error('compile recorded no circuits — is the rust backend active?');

// ---------------------------------------------------------------------------
// 2. One real deposit — same branch again, this time with a solved witness.
//
// The witness is what makes the export useful: the Rust side can prove
// immediately instead of having to re-derive it. Anything deposit-specific in
// it (sender, recipient, amount) is a placeholder the caller substitutes.
// ---------------------------------------------------------------------------

const Local = await Mina.LocalBlockchain({ proofsEnabled: true });
Mina.setActiveInstance(Local);

const deployerKey = Local.testAccounts[0].key;
const deployer = deployerKey.toPublicKey();
const userKey = Local.testAccounts[1].key;
const user = userKey.toPublicKey();
const zkAppKey = PrivateKey.random();
const zkAppAddress = zkAppKey.toPublicKey();
const bridge = new MinaPortBridge(zkAppAddress);

const deployTx = await Mina.transaction(deployer, async () => {
  AccountUpdate.fundNewAccount(deployer);
  await bridge.deploy({ admin: deployer, withdrawalAttestor: deployer });
});
await deployTx.prove();
await deployTx.sign([deployerKey, zkAppKey]).send();

recordings.length = 0;
const SAMPLE = {
  nonce: 0n,
  recipient: '0x1111111111111111111111111111111111111111',
  amountNanomina: 2_000_000_000n,
};

const proveStart = Date.now();
const depositTx = await Mina.transaction(user, async () => {
  await bridge.deposit(
    UInt64.from(SAMPLE.nonce),
    flareRecipientField(SAMPLE.recipient),
    UInt64.from(SAMPLE.amountNanomina),
  );
});
await depositTx.prove();
const proveMs = Date.now() - proveStart;
await depositTx.sign([userKey]).send();

if (recordings.length === 0) throw Error('the deposit recorded no circuit');
// The last recording is the one the prover actually consumed.
const deposit = recordings[recordings.length - 1];

// The branch whose circuit matches is the one Rust must prove. Comparing the
// serialized circuit rather than trusting declaration order means a reordered
// contract cannot silently point the prover at the wrong method.
const depositCircuit = JSON.stringify(deposit.circuit);
const depositBranch = branches.findIndex((b) => JSON.stringify(b.circuit) === depositCircuit);
if (depositBranch < 0) throw Error('the deposit circuit is not one of the compiled branches');

// ---------------------------------------------------------------------------
// 3. Write the package.
// ---------------------------------------------------------------------------

const packaged = {
  contract: 'MinaPortBridge',
  o1jsVerificationKeyHash: verificationKey.hash.toString(),
  depositBranch,
  branches,
  depositWitness: deposit.witness,
  sample: {
    nonce: SAMPLE.nonce.toString(),
    recipient: SAMPLE.recipient,
    amountNanomina: SAMPLE.amountNanomina.toString(),
  },
  o1jsTimings: { compileMs, proveMs },
};

await writeFile(outPath, JSON.stringify(packaged));
process.stderr.write(
  `${branches.length} branches, deposit is branch ${depositBranch}, ` +
    `witness ${deposit.witness.length} values, vk ${packaged.o1jsVerificationKeyHash}\n` +
    `o1js reference: compile ${(compileMs / 1000).toFixed(1)}s, prove ${(proveMs / 1000).toFixed(1)}s\n` +
    `written to ${outPath}\n`,
);
process.exit(0);
