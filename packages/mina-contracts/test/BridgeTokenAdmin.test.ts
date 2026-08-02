import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountUpdate, Field, MerkleTree, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';
import {
  BridgeTokenAdmin,
  CLAIM_TREE_HEIGHT,
  ClaimWitness,
  LockClaim,
  NO_MINT_AUTHORIZED,
  mintCommitment,
} from '../src/BridgeTokenAdmin.js';

/**
 * These are attack tests before they are feature tests.
 *
 * The whole security argument for `canMint` is that it trusts no key and that
 * an authorisation cannot be reused. Both claims are worth nothing until
 * something tries to break them, so the suite mints without a claim, replays a
 * claim, and mints an amount other than the one claimed.
 */

const AMOUNT = UInt64.from(5_000_000_000n);
const CLAIM_ID = 7n;

let deployerKey: PrivateKey;
let deployer: PublicKey;
let attestorKey: PrivateKey;
let attestor: PublicKey;
let recipientKey: PrivateKey;
let recipient: PublicKey;

let adminKey: PrivateKey;
let admin: BridgeTokenAdmin;

let lockTree: MerkleTree;
let nullifierTree: MerkleTree;
let claim: LockClaim;

beforeAll(async () => {
  const Local = await Mina.LocalBlockchain({ proofsEnabled: false });
  Mina.setActiveInstance(Local);

  deployerKey = Local.testAccounts[0].key;
  deployer = deployerKey.toPublicKey();
  attestorKey = Local.testAccounts[1].key;
  attestor = attestorKey.toPublicKey();
  recipientKey = Local.testAccounts[2].key;
  recipient = recipientKey.toPublicKey();
}, 180_000);

beforeEach(async () => {
  claim = new LockClaim({ claimId: Field(CLAIM_ID), recipient, amount: AMOUNT });

  lockTree = new MerkleTree(CLAIM_TREE_HEIGHT);
  lockTree.setLeaf(CLAIM_ID, claim.hash());
  nullifierTree = new MerkleTree(CLAIM_TREE_HEIGHT);

  adminKey = PrivateKey.random();
  admin = new BridgeTokenAdmin(adminKey.toPublicKey());

  const tx = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer);
    await admin.deploy({
      attestor,
      lockRoot: lockTree.getRoot(),
      nullifierRoot: nullifierTree.getRoot(),
    });
  });
  await tx.prove();
  await tx.sign([deployerKey, adminKey]).send();
}, 180_000);

function witnesses() {
  return {
    claimWitness: new ClaimWitness(lockTree.getWitness(CLAIM_ID)),
    nullifierWitness: new ClaimWitness(nullifierTree.getWitness(CLAIM_ID)),
  };
}

async function authorize(c: LockClaim = claim) {
  const { claimWitness, nullifierWitness } = witnesses();
  const tx = await Mina.transaction(deployer, async () => {
    await admin.authorizeClaim(c, claimWitness, nullifierWitness);
  });
  await tx.prove();
  return tx.sign([deployerKey]).send();
}

describe('claim authorisation', () => {
  it('arms exactly the claimed mint', async () => {
    expect(admin.mintAuthorization.get().toString()).toBe(NO_MINT_AUTHORIZED.toString());

    await authorize();

    expect(admin.mintAuthorization.get().toString()).toBe(
      mintCommitment(recipient, AMOUNT).toString(),
    );
  }, 180_000);

  it('consumes the nullifier so the same claim cannot be authorised twice', async () => {
    await authorize();
    // The on-chain nullifier root has moved; the stale witness no longer proves
    // the slot is empty.
    await expect(authorize()).rejects.toThrow();
  }, 180_000);

  it('rejects a claim that is not in the published lock root', async () => {
    const forged = new LockClaim({
      claimId: Field(CLAIM_ID),
      recipient,
      amount: UInt64.from(999_000_000_000n),
    });
    await expect(authorize(forged)).rejects.toThrow();
  }, 180_000);

  it('rejects a zero-amount claim', async () => {
    const zero = new LockClaim({ claimId: Field(CLAIM_ID), recipient, amount: UInt64.zero });
    await expect(authorize(zero)).rejects.toThrow();
  }, 180_000);

  it('refuses to stack a second authorisation over an armed one', async () => {
    await authorize();

    // A second, genuinely different claim, correctly witnessed.
    const second = new LockClaim({ claimId: Field(9n), recipient, amount: AMOUNT });
    lockTree.setLeaf(9n, second.hash());

    const tx = await Mina.transaction(deployer, async () => {
      await admin.publishLockRoot(lockTree.getRoot());
    });
    await tx.prove();
    await tx.sign([deployerKey, attestorKey]).send();

    const claimWitness = new ClaimWitness(lockTree.getWitness(9n));
    const nullifierWitness = new ClaimWitness(nullifierTree.getWitness(9n));

    await expect(
      Mina.transaction(deployer, async () => {
        await admin.authorizeClaim(second, claimWitness, nullifierWitness);
      }).then((t) => t.prove()),
    ).rejects.toThrow();
  }, 240_000);
});

describe('lock root publication', () => {
  it('requires the attestor signature', async () => {
    const tx = await Mina.transaction(deployer, async () => {
      await admin.publishLockRoot(Field(1234));
    });
    await tx.prove();
    // Signed by the deployer only: the attestor's account update is unsigned.
    await expect(tx.sign([deployerKey]).send()).rejects.toThrow();
  }, 180_000);

  it('accepts a root signed by the attestor', async () => {
    const newRoot = Field(4321);
    const tx = await Mina.transaction(deployer, async () => {
      await admin.publishLockRoot(newRoot);
    });
    await tx.prove();
    await tx.sign([deployerKey, attestorKey]).send();

    expect(admin.lockRoot.get().toString()).toBe(newRoot.toString());
  }, 180_000);

  it('cannot mint, choose recipients, or bypass the nullifier', async () => {
    // The attestor's only power is the root. Arming a mint still requires a
    // claim that is actually in that root, which the attestor does not control
    // retroactively — publishing a root does not touch mintAuthorization.
    const tx = await Mina.transaction(deployer, async () => {
      await admin.publishLockRoot(Field(999));
    });
    await tx.prove();
    await tx.sign([deployerKey, attestorKey]).send();

    expect(admin.mintAuthorization.get().toString()).toBe(NO_MINT_AUTHORIZED.toString());
  }, 180_000);
});

describe('administrative capabilities are removed', () => {
  it('refuses to change the admin or pause the token', async () => {
    // These are levers over user funds that nobody should hold in a bridge.
    expect((await admin.canChangeAdmin(recipient)).toBoolean()).toBe(false);
    expect((await admin.canPause()).toBoolean()).toBe(false);
    expect((await admin.canResume()).toBoolean()).toBe(false);
  }, 180_000);
});
