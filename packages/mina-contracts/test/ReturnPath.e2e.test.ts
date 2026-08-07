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
import { MinaPortBridge, flareRecipientField } from '../src/MinaPortBridge.js';
import { TransferChain, TransferRecord, applyTransfer } from '../src/TransferChain.js';
import { keccak256 } from 'viem';
import { Bytes38, RelayMessage } from '../src/RelayMessage.js';
import { AttestationResponse, FdcAttestation, FdcLeaf } from '../src/FdcAttestation.js';
import { MerkleInclusion } from '../src/MerkleInclusion.js';
import {
  Bytes32,
  EcdsaSignature,
  POLICY_TREE_HEIGHT,
  PolicyWitness,
  Secp256k1,
  SigningPolicyFold,
  policyLeaf,
} from '../src/SigningPolicyFold.js';

const FLARE_BRIDGE = Field(BigInt('0x871493412EDCcfE0d24f127E6Deb2B20AE5497aB'));
const FMINA = Field(BigInt('0x1234567890AbcdEF1234567890aBcdef12345678'));
const TOPIC0 = BigInt('0x1e0b6b1f6b2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5');

it('end to end with real proofs', async () => {
  const t = (s: string, ms: number) => console.log(`${s.padEnd(34)} ${(ms / 1000).toFixed(1)}s`);
  const MINA = 1_000_000_000n;
  let m = Date.now();

  await TransferChain.compile();                         t('compile TransferChain', Date.now() - m);
  m = Date.now(); await RelayMessage.compile();           t('compile RelayMessage', Date.now() - m);
  m = Date.now(); await SigningPolicyFold.compile();     t('compile SigningPolicyFold', Date.now() - m);
  m = Date.now(); await MerkleInclusion.compile();       t('compile MerkleInclusion', Date.now() - m);
  m = Date.now(); await FdcLeaf.compile();               t('compile FdcLeaf', Date.now() - m);
  m = Date.now(); await FdcAttestation.compile();        t('compile FdcAttestation', Date.now() - m);
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
      flareChain: FLARE_BRIDGE,
      token: FMINA,
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
  const w1 = new TransferRecord({ index: UInt64.from(1n), token: FMINA, recipient: user, amount: UInt64.from(MINA) });
  const s1 = applyTransfer(Field(0), w1);
  const w2 = new TransferRecord({ index: UInt64.from(2n), token: FMINA, recipient: user, amount: UInt64.from(2n * MINA) });
  const s2 = applyTransfer(s1, w2);

  // The attestation Flare would produce for a `WithdrawToMina` carrying `s2`.
  const response = new Uint8Array(1344);
  const putWord = (word: number, value: bigint) => {
    for (let i = 0; i < 32; i++) {
      response[word * 32 + 31 - i] = Number((value >> BigInt(8 * i)) & 0xffn);
    }
  };
  putWord(28, FLARE_BRIDGE.toBigInt());
  putWord(33, TOPIC0);
  putWord(41, s2.toBigInt());

  const leafHex = keccak256(`0x${Buffer.from(response).toString('hex')}` as `0x${string}`);
  const siblingHex = keccak256('0xdeadbeef');
  const [lo, hi] =
    leafHex.toLowerCase() < siblingHex.toLowerCase() ? [leafHex, siblingHex] : [siblingHex, leafHex];
  const rootHex = keccak256(`0x${lo.slice(2)}${hi.slice(2)}` as `0x${string}`);

  m = Date.now();
  const { proof: relayProof } = await RelayMessage.bind(
    Bytes38.fromHex('c80015a2b401' + rootHex.slice(2)),
  );
  t('prove relay message binding', Date.now() - m);
  const msg = Bytes32.from(relayProof.publicOutput.digest.bytes);

  m = Date.now();
  const { proof: sp } = await SigningPolicyFold.single(relayProof, policyTree.getRoot(), {
    publicKey: validator,
    signature: EcdsaSignature.signHash(msg, validatorKey),
    index: UInt32.from(0),
    weight: UInt32.from(1),
    witness: new PolicyWitness(policyTree.getWitness(0n)),
  } as never);
  t('prove signing policy (1 ECDSA)', Date.now() - m);

  m = Date.now();
  const { proof: inclusion } = await MerkleInclusion.level(
    Bytes32.fromHex(leafHex.slice(2)),
    Bytes32.fromHex(siblingHex.slice(2)),
  );
  const { proof: leafProof } = await FdcLeaf.read(AttestationResponse.from(response), inclusion);
  t('prove FDC leaf (10 keccak blocks)', Date.now() - m);

  m = Date.now();
  const { proof: attestation } = await FdcAttestation.attest(leafProof, sp);
  t('prove FDC attestation', Date.now() - m);

  m = Date.now();
  tx = await Mina.transaction(deployer, async () => { await bridge.publishFlareActionState(attestation); });
  await tx.prove(); await tx.sign([deployerKey]).send();
  t('publishFlareActionState', Date.now() - m);

  // Read from the attested event, not named by anyone.
  expect(bridge.flareActionState.get().toString()).toBe(s2.toString());

  m = Date.now();
  const { proof: e0 } = await TransferChain.empty(Field(0), FMINA);
  const { proof: l1 } = await TransferChain.link(Field(0), FMINA, w1);
  const { proof: l2 } = await TransferChain.link(s1, FMINA, w2);
  const { proof: half } = await TransferChain.merge(e0, l1);
  const { proof: seg1 } = await TransferChain.merge(half, l2);
  t('prove segment (2 links)', Date.now() - m);

  const before = Mina.getBalance(user).toBigInt();
  m = Date.now();
  tx = await Mina.transaction(deployer, async () => { await bridge.releaseWithdrawal(seg1); });
  await tx.prove(); await tx.sign([deployerKey]).send();
  t('releaseWithdrawal #1', Date.now() - m);

  m = Date.now();
  const { proof: e1 } = await TransferChain.empty(s1, FMINA);
  const { proof: seg2 } = await TransferChain.merge(e1, l2);
  t('prove segment (1 link)', Date.now() - m);
  m = Date.now();
  tx = await Mina.transaction(deployer, async () => { await bridge.releaseWithdrawal(seg2); });
  await tx.prove(); await tx.sign([deployerKey]).send();
  t('releaseWithdrawal #2', Date.now() - m);

  // The cursor has caught up with what Flare committed to, both users were
  // paid exactly what the chain said, and the escrow shrank by exactly that.
  expect(bridge.processedActionState.get().toString()).toBe(s2.toString());
  expect(Mina.getBalance(user).toBigInt() - before).toBe(3n * MINA);
  expect(Mina.getBalance(zkApp).toBigInt()).toBe(2n * MINA);
}, 3_600_000);
