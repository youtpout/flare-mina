/**
 * The return path, end to end, with real proofs.
 *
 * Every other suite here runs `proofsEnabled: false`, which exercises the
 * constraints but never produces a proof. That is not enough on its own:
 * `MerkleInclusion` measured cleanly for weeks and still failed inside Pickles
 * at `compile()`. This is the test that would have caught it.
 *
 * It deposits, publishes an attested Flare chain state, then releases two
 * withdrawals — the first against a one-link tail, the second against an empty
 * one. Roughly 70s on an M4, which is why it is one test rather than several.
 */
import { expect, it } from 'vitest';
import { AccountUpdate, Field, MerkleTree, Mina, PrivateKey, UInt32, UInt64 } from 'o1js';
import { MinaPortBridge, WithdrawalRecord, flareRecipientField } from '../src/MinaPortBridge.js';
import { WithdrawalChain, applyWithdrawal } from '../src/WithdrawalChain.js';
import {
  Bytes32,
  EcdsaSignature,
  POLICY_TREE_HEIGHT,
  PolicyWitness,
  Secp256k1,
  SigningPolicyFold,
  policyLeaf,
} from '../src/SigningPolicyFold.js';

it('end to end with real proofs', async () => {
  const t = (s: string, ms: number) => console.log(`${s.padEnd(34)} ${(ms / 1000).toFixed(1)}s`);
  const MINA = 1_000_000_000n;
  let m = Date.now();

  await WithdrawalChain.compile();                       t('compile WithdrawalChain', Date.now() - m);
  m = Date.now(); await SigningPolicyFold.compile();     t('compile SigningPolicyFold', Date.now() - m);
  m = Date.now(); await MinaPortBridge.compile();        t('compile MinaPortBridge', Date.now() - m);

  const Local = await Mina.LocalBlockchain({ proofsEnabled: true });
  Mina.setActiveInstance(Local);
  const deployerKey = Local.testAccounts[0].key, deployer = deployerKey.toPublicKey();
  const userKey = Local.testAccounts[1].key, user = userKey.toPublicKey();
  const attestorKey = Local.testAccounts[2].key, attestor = attestorKey.toPublicKey();
  const zkAppKey = PrivateKey.random(), zkApp = zkAppKey.toPublicKey();
  const bridge = new MinaPortBridge(zkApp);

  // One validator, committed to a Poseidon policy tree the circuit checks
  // membership against.
  const validatorKey = Secp256k1.Scalar.random().toBigInt();
  const validator = Secp256k1.generator.scale(validatorKey);
  const policyTree = new MerkleTree(POLICY_TREE_HEIGHT);
  policyTree.setLeaf(0n, policyLeaf(validator, UInt32.from(0), UInt32.from(1)));

  m = Date.now();
  let tx = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer);
    await bridge.deploy({
      admin: deployer,
      withdrawalAttestor: attestor,
      signingPolicyRoot: policyTree.getRoot(),
    });
  });
  await tx.prove(); await tx.sign([deployerKey, zkAppKey]).send();
  t('deploy', Date.now() - m);

  m = Date.now();
  tx = await Mina.transaction(user, async () => {
    await bridge.deposit(UInt64.from(1n), flareRecipientField('0x1111111111111111111111111111111111111111'), UInt64.from(5n * MINA));
  });
  await tx.prove(); await tx.sign([userKey]).send();
  t('deposit (5 MINA escrowed)', Date.now() - m);

  // Flare's chain: two withdrawals.
  const w1 = new WithdrawalRecord({ nonce: UInt64.from(1n), recipient: user, amount: UInt64.from(MINA) });
  const s1 = applyWithdrawal(Field(0), w1);
  const w2 = new WithdrawalRecord({ nonce: UInt64.from(2n), recipient: user, amount: UInt64.from(2n * MINA) });
  const s2 = applyWithdrawal(s1, w2);

  m = Date.now();
  const msg = Bytes32.random();
  const { proof: sp } = await SigningPolicyFold.single(msg, policyTree.getRoot(), {
    publicKey: validator,
    signature: EcdsaSignature.signHash(msg, validatorKey),
    index: UInt32.from(0),
    weight: UInt32.from(1),
    witness: new PolicyWitness(policyTree.getWitness(0n)),
  } as never);
  t('prove signing policy (1 ECDSA)', Date.now() - m);

  m = Date.now();
  tx = await Mina.transaction(deployer, async () => { await bridge.publishFlareActionState(s2, sp); });
  await tx.prove(); await tx.sign([deployerKey, attestorKey]).send();
  t('publishFlareActionState', Date.now() - m);

  m = Date.now();
  const { proof: tail1 } = await WithdrawalChain.link(s1, w2);
  t('prove tail (1 link)', Date.now() - m);

  const before = Mina.getBalance(user).toBigInt();
  m = Date.now();
  tx = await Mina.transaction(deployer, async () => { await bridge.releaseWithdrawal(w1, tail1); });
  await tx.prove(); await tx.sign([deployerKey]).send();
  t('releaseWithdrawal #1', Date.now() - m);

  m = Date.now();
  const { proof: tail2 } = await WithdrawalChain.empty(s2);
  t('prove tail (empty)', Date.now() - m);
  m = Date.now();
  tx = await Mina.transaction(deployer, async () => { await bridge.releaseWithdrawal(w2, tail2); });
  await tx.prove(); await tx.sign([deployerKey]).send();
  t('releaseWithdrawal #2', Date.now() - m);

  // The cursor has caught up with what Flare committed to, both users were
  // paid exactly what the chain said, and the escrow shrank by exactly that.
  expect(bridge.processedActionState.get().toString()).toBe(s2.toString());
  expect(Mina.getBalance(user).toBigInt() - before).toBe(3n * MINA);
  expect(Mina.getBalance(zkApp).toBigInt()).toBe(2n * MINA);
}, 3_600_000);
