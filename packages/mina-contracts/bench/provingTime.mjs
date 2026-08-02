/**
 * How long does a user actually wait?
 *
 * Measures real proof generation for the zkApp methods on the deposit path,
 * with proofs enabled — the numbers a claimant experiences, as opposed to the
 * `proofsEnabled: false` figures a test suite reports.
 *
 * Run: node bench/provingTime.mjs
 */
import { AccountUpdate, Field, MerkleTree, Mina, PrivateKey, UInt64 } from 'o1js';
import {
  BridgeTokenAdmin,
  CLAIM_TREE_HEIGHT,
  ClaimWitness,
  LockClaim,
} from '../dist/src/BridgeTokenAdmin.js';

const time = async (label, fn) => {
  const t0 = performance.now();
  const out = await fn();
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(38)} ${(ms / 1000).toFixed(1)} s`);
  return out;
};

console.log(`node ${process.version}, ${process.arch} on ${process.platform}\n`);

const Local = await Mina.LocalBlockchain({ proofsEnabled: true });
Mina.setActiveInstance(Local);

await time('compile BridgeTokenAdmin', () => BridgeTokenAdmin.compile());

const deployerKey = Local.testAccounts[0].key;
const deployer = deployerKey.toPublicKey();
const attestor = Local.testAccounts[1].key.toPublicKey();
const recipient = Local.testAccounts[2].key.toPublicKey();

const adminKey = PrivateKey.random();
const admin = new BridgeTokenAdmin(adminKey.toPublicKey());

const claim = new LockClaim({
  claimId: Field(7n),
  recipient,
  amount: UInt64.from(5_000_000_000n),
});
const lockTree = new MerkleTree(CLAIM_TREE_HEIGHT);
lockTree.setLeaf(7n, claim.hash());
const nullifierTree = new MerkleTree(CLAIM_TREE_HEIGHT);

await time('deploy (prove + send)', async () => {
  const tx = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer, 1);
    await admin.deploy({
      attestor,
      lockRoot: lockTree.getRoot(),
      nullifierRoot: nullifierTree.getRoot(),
    });
  });
  await tx.prove();
  return tx.sign([deployerKey, adminKey]).send();
});

const claimWitness = new ClaimWitness(lockTree.getWitness(7n));
const nullifierWitness = new ClaimWitness(nullifierTree.getWitness(7n));

// The number that matters: what a claimant waits for.
await time('authorizeClaim — build transaction', async () => {
  const tx = await Mina.transaction(deployer, async () => {
    await admin.authorizeClaim(claim, claimWitness, nullifierWitness);
  });
  globalThis.__tx = tx;
});

await time('authorizeClaim — PROVE', () => globalThis.__tx.prove());
await time('authorizeClaim — send', async () => globalThis.__tx.sign([deployerKey]).send());
