/**
 * The asset rail, end to end, with real proofs.
 *
 * Flare locks FXRP and folds it into a Poseidon chain; this replays that chain
 * and mints the wrapped token on Mina. Proofs are enabled throughout, and they
 * have to be: with `proofsEnabled: false` o1js stubs nested proofs, so
 * `FungibleToken.mint` never actually runs `canMint` — and a suite whose whole
 * purpose is to show that an unauthorised mint fails would pass without ever
 * calling the code that refuses it.
 *
 * The attack cases come first, because "minting works" is worth nothing if
 * minting also works without a lock.
 */
import { expect, it } from 'vitest';
import {
  AccountUpdate,
  Bool,
  Field,
  MerkleTree,
  Mina,
  PrivateKey,
  UInt8,
  UInt32,
  UInt64,
} from 'o1js';
import { keccak256 } from 'viem';
import { FungibleToken } from 'mina-fungible-token';
import { AssetPort, NO_MINT_AUTHORIZED } from '../src/AssetPort.js';
import { LockChain, LockRecord, applyLock } from '../src/LockChain.js';
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

/** The vault on Coston2, and the `AssetLocked` signature. */
const VAULT = Field(BigInt('0xa179E908C3F1156Edda0BD5f1A0B3b3f419f9F90'));
const TOPIC0 = BigInt('0x078ee1eead8e83dabf8464df5a5e308db068b136607c9f7bef8e86f6fc783add');

it('locks on Flare, mints on Mina', async () => {
  const t = (s: string, ms: number) => console.log(`${s.padEnd(34)} ${(ms / 1000).toFixed(1)}s`);
  let m = Date.now();

  // The token's designated override point. Without it the token resolves its
  // admin as the default `FungibleTokenAdmin`, and a test expecting rejection
  // would pass for entirely the wrong reason.
  FungibleToken.AdminContract = AssetPort as never;

  await LockChain.compile();                          t('compile LockChain', Date.now() - m);
  m = Date.now(); await RelayMessage.compile();       t('compile RelayMessage', Date.now() - m);
  m = Date.now(); await SigningPolicyFold.compile();  t('compile SigningPolicyFold', Date.now() - m);
  m = Date.now(); await MerkleInclusion.compile();    t('compile MerkleInclusion', Date.now() - m);
  m = Date.now(); await FdcLeaf.compile();            t('compile FdcLeaf', Date.now() - m);
  m = Date.now(); await FdcAttestation.compile();     t('compile FdcAttestation', Date.now() - m);
  m = Date.now(); await AssetPort.compile();          t('compile AssetPort', Date.now() - m);
  m = Date.now(); await FungibleToken.compile();      t('compile FungibleToken', Date.now() - m);

  const Local = await Mina.LocalBlockchain({ proofsEnabled: true });
  Mina.setActiveInstance(Local);
  const deployerKey = Local.testAccounts[0].key, deployer = deployerKey.toPublicKey();
  const userKey = Local.testAccounts[1].key, user = userKey.toPublicKey();
  const portKey = PrivateKey.random(), portAddress = portKey.toPublicKey();
  const tokenKey = PrivateKey.random();
  const port = new AssetPort(portAddress);
  const token = new FungibleToken(tokenKey.toPublicKey());

  // One validator, committed to a Poseidon policy tree the circuit checks
  // membership against.
  const validatorKey = Secp256k1.Scalar.random().toBigInt();
  const validator = Secp256k1.generator.scale(validatorKey);
  const policyTree = new MerkleTree(POLICY_TREE_HEIGHT);
  policyTree.setLeaf(0n, policyLeaf(validator, UInt32.from(0), UInt32.from(1)));

  // The port must exist before the token is initialized against it: the token
  // resolves its admin by address, and an undeployed account yields an empty
  // PublicKey that is not a curve point.
  m = Date.now();
  let tx = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer);
    await port.deploy({ admin: deployer, vault: VAULT, signingPolicyRoot: policyTree.getRoot() });
  });
  await tx.prove(); await tx.sign([deployerKey, portKey]).send();

  tx = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer, 2);
    // FXRP is 6 decimals on Flare and stays 6 here: bridged decimals are never
    // converted, so a base unit means the same thing on both chains.
    await token.deploy({ symbol: 'bFXRP', src: 'https://github.com/youtpout/flare-mina', allowUpdates: false });
    await token.initialize(portAddress, UInt8.from(6), Bool(false));
  });
  await tx.prove(); await tx.sign([deployerKey, tokenKey]).send();
  t('deploy port + token', Date.now() - m);

  // ---------------------------------------------------------------------
  // The single most important case: an unbacked mint must be impossible.
  // ---------------------------------------------------------------------
  await expect(
    Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer, 1);
      await token.mint(user, UInt64.from(1_000_000n));
    }).then((x) => x.prove()),
  ).rejects.toThrow();

  // Flare's chain for this token: two locks, 1.0 and 0.25 FXRP.
  const l1 = new LockRecord({ claimId: UInt64.from(0n), recipient: user, amount: UInt64.from(1_000_000n) });
  const s1 = applyLock(Field(0), l1);
  const l2 = new LockRecord({ claimId: UInt64.from(1n), recipient: user, amount: UInt64.from(250_000n) });
  const s2 = applyLock(s1, l2);

  // ---------------------------------------------------------------------
  // Build the attestation the way Flare would: an event carrying `s2`, hashed
  // into a leaf, placed in a round tree whose root the validators then sign.
  // ---------------------------------------------------------------------
  const response = new Uint8Array(1344);
  const putWord = (word: number, value: bigint) => {
    for (let i = 0; i < 32; i++) {
      response[word * 32 + 31 - i] = Number((value >> BigInt(8 * i)) & 0xffn);
    }
  };
  putWord(28, VAULT.toBigInt());        // emitter
  putWord(33, TOPIC0);                  // event signature
  putWord(41, s2.toBigInt());           // newActionState — the last word

  const leafHex = keccak256(`0x${Buffer.from(response).toString('hex')}` as `0x${string}`);
  // A one-level tree: our leaf and one sibling.
  const siblingHex = keccak256('0xdeadbeef');
  const [lo, hi] =
    leafHex.toLowerCase() < siblingHex.toLowerCase() ? [leafHex, siblingHex] : [siblingHex, leafHex];
  const rootHex = keccak256(`0x${lo.slice(2)}${hi.slice(2)}` as `0x${string}`);

  // The round message the validators sign carries that root.
  const { proof: relayProof } = await RelayMessage.bind(
    Bytes38.fromHex('c80015a2b401' + rootHex.slice(2)),
  );
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
  t('prove merkle inclusion', Date.now() - m);

  m = Date.now();
  const { proof: leafProof } = await FdcLeaf.read(AttestationResponse.from(response), inclusion);
  t('prove FDC leaf (10 keccak blocks)', Date.now() - m);

  m = Date.now();
  const { proof: attestation } = await FdcAttestation.attest(leafProof, sp);
  t('prove FDC attestation', Date.now() - m);

  m = Date.now();
  tx = await Mina.transaction(deployer, async () => { await port.publishFlareLockState(attestation); });
  await tx.prove(); await tx.sign([deployerKey]).send();
  t('publishFlareLockState', Date.now() - m);

  // The head the port accepted came out of the attested event, not from an
  // argument — nothing in this transaction let anyone name it.
  expect(port.flareLockState.get().toString()).toBe(s2.toString());

  // A record Flare never folded has no continuation reaching the attested head,
  // so it cannot be authorised however well-formed it looks.
  const forged = new LockRecord({ claimId: UInt64.from(0n), recipient: user, amount: UInt64.from(9_999_999n) });
  const { proof: forgedTail } = await LockChain.empty(s2);
  await expect(
    Mina.transaction(deployer, async () => { await port.authorizeMint(forged, forgedTail); }).then((x) => x.prove()),
  ).rejects.toThrow();

  m = Date.now();
  const { proof: tail1 } = await LockChain.link(s1, l2);
  t('prove tail (1 link)', Date.now() - m);

  m = Date.now();
  tx = await Mina.transaction(deployer, async () => { await port.authorizeMint(l1, tail1); });
  await tx.prove(); await tx.sign([deployerKey]).send();
  t('authorizeMint #1', Date.now() - m);

  // Armed for exactly one mint, bound to that recipient and that amount.
  await expect(
    Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer, 1);
      await token.mint(user, UInt64.from(2_000_000n));
    }).then((x) => x.prove()),
  ).rejects.toThrow(/mint does not match the authorised lock/);

  const thief = PrivateKey.random().toPublicKey();
  await expect(
    Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer, 1);
      await token.mint(thief, UInt64.from(1_000_000n));
    }).then((x) => x.prove()),
  ).rejects.toThrow(/mint does not match the authorised lock/);

  m = Date.now();
  tx = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer, 1);
    await token.mint(user, UInt64.from(1_000_000n));
  });
  await tx.prove(); await tx.sign([deployerKey]).send();
  t('mint #1', Date.now() - m);

  // One shot: the authorisation is spent, and a replay needs a fresh lock.
  expect(port.mintAuthorization.get().toString()).toBe(NO_MINT_AUTHORIZED.toString());
  await expect(
    Mina.transaction(deployer, async () => { await token.mint(user, UInt64.from(1_000_000n)); }).then((x) => x.prove()),
  ).rejects.toThrow(/no mint is authorised/);

  // The second lock, against an empty tail — it is the newest link in the chain.
  m = Date.now();
  const { proof: tail2 } = await LockChain.empty(s2);
  tx = await Mina.transaction(deployer, async () => { await port.authorizeMint(l2, tail2); });
  await tx.prove(); await tx.sign([deployerKey]).send();
  tx = await Mina.transaction(deployer, async () => { await token.mint(user, UInt64.from(250_000n)); });
  await tx.prove(); await tx.sign([deployerKey]).send();
  t('authorizeMint + mint #2', Date.now() - m);

  // The cursor has caught up with what Flare committed to, and the supply
  // minted here is exactly what the chain said was locked there.
  expect(port.processedLockState.get().toString()).toBe(s2.toString());
  expect((await token.getBalanceOf(user)).toBigInt()).toBe(1_250_000n);
  expect((await token.getCirculating()).toBigInt()).toBe(1_250_000n);
}, 3_600_000);
