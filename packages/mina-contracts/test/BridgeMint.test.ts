import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountUpdate,
  Bool,
  Field,
  MerkleTree,
  Mina,
  PrivateKey,
  PublicKey,
  UInt8,
  UInt64,
} from 'o1js';
import { FungibleToken } from 'mina-fungible-token';
import {
  BridgeTokenAdmin,
  CLAIM_TREE_HEIGHT,
  ClaimWitness,
  LockClaim,
  NO_MINT_AUTHORIZED,
} from '../src/BridgeTokenAdmin.js';

/**
 * End-to-end: a real `FungibleToken` wired to `BridgeTokenAdmin`.
 *
 * The previous suite proved the admin's own invariants. This one exercises the
 * path that actually matters — `token.mint()` calling back into `canMint()` —
 * and answers the question that design rested on: whether a second account
 * update on the admin, in the same transaction, observes the state written by
 * the first.
 *
 * The attack cases come first, because "minting works" is worth nothing if
 * minting also works without a claim.
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
let tokenKey: PrivateKey;
let token: FungibleToken;

let lockTree: MerkleTree;
let nullifierTree: MerkleTree;
let claim: LockClaim;

beforeAll(async () => {
  // Proofs MUST be enabled here. With `proofsEnabled: false` o1js stubs nested
  // proofs, so `FungibleToken.mint` never actually executes the admin's
  // `canMint` — and a suite whose whole purpose is to prove that `canMint`
  // blocks unauthorised mints would pass without ever running it.
  const Local = await Mina.LocalBlockchain({ proofsEnabled: true });
  Mina.setActiveInstance(Local);

  // The standard's designated override point. Without it the token resolves
  // its admin as the default `FungibleTokenAdmin`, and every `canMint` call
  // fails for want of a prover — which a test expecting rejection would happily
  // report as a pass, for entirely the wrong reason.
  FungibleToken.AdminContract = BridgeTokenAdmin;

  await BridgeTokenAdmin.compile();
  await FungibleToken.compile();

  deployerKey = Local.testAccounts[0].key;
  deployer = deployerKey.toPublicKey();
  attestorKey = Local.testAccounts[1].key;
  attestor = attestorKey.toPublicKey();
  recipientKey = Local.testAccounts[2].key;
  recipient = recipientKey.toPublicKey();
}, 300_000);

beforeEach(async () => {
  claim = new LockClaim({ claimId: Field(CLAIM_ID), recipient, amount: AMOUNT });

  lockTree = new MerkleTree(CLAIM_TREE_HEIGHT);
  lockTree.setLeaf(CLAIM_ID, claim.hash());
  nullifierTree = new MerkleTree(CLAIM_TREE_HEIGHT);

  adminKey = PrivateKey.random();
  admin = new BridgeTokenAdmin(adminKey.toPublicKey());
  tokenKey = PrivateKey.random();
  token = new FungibleToken(tokenKey.toPublicKey());

  // The admin must exist before the token is initialized against it: the token
  // resolves its admin contract by address, and initializing against an
  // undeployed account yields an empty PublicKey that is not a curve point.
  const deployAdmin = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer, 1);
    await admin.deploy({
      attestor,
      lockRoot: lockTree.getRoot(),
      nullifierRoot: nullifierTree.getRoot(),
    });
  });
  await deployAdmin.prove();
  await deployAdmin.sign([deployerKey, adminKey]).send();

  const deployToken = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer, 2);
    await token.deploy({
      symbol: 'bFXRP',
      src: 'https://github.com/youtpout/flare-mina',
      // The bridge admin refuses verification-key changes anyway; saying so
      // here keeps the token's own flag consistent with that refusal.
      allowUpdates: false,
    });
    await token.initialize(adminKey.toPublicKey(), UInt8.from(6), Bool(false));
  });
  await deployToken.prove();
  await deployToken.sign([deployerKey, tokenKey]).send();
}, 300_000);

/**
 * Authorise the claim, then mint it — in TWO transactions.
 *
 * They cannot be combined. A second account update on the same zkApp does not
 * observe state written by an earlier one in the same transaction: preconditions
 * are evaluated against the state as of the transaction's start. So `canMint`
 * would read `mintAuthorization` as empty and refuse, even with a valid claim
 * armed a few lines above.
 *
 * Security does not depend on the two being atomic. The one-shot property comes
 * from the nullifier consumed in `authorizeClaim` and from `canMint` resetting
 * the authorisation, neither of which cares about transaction boundaries. What
 * is lost is only convenience: a claimant sends two transactions instead of one.
 */
async function authorizeClaimTx() {
  const claimWitness = new ClaimWitness(lockTree.getWitness(CLAIM_ID));
  const nullifierWitness = new ClaimWitness(nullifierTree.getWitness(CLAIM_ID));

  const tx = await Mina.transaction(deployer, async () => {
    await admin.authorizeClaim(claim, claimWitness, nullifierWitness);
  });
  await tx.prove();
  return tx.sign([deployerKey]).send();
}

async function mintTx(to = recipient, amount = AMOUNT, fundNew = true) {
  const tx = await Mina.transaction(deployer, async () => {
    if (fundNew) AccountUpdate.fundNewAccount(deployer, 1);
    await token.mint(to, amount);
  });
  await tx.prove();
  return tx.sign([deployerKey]).send();
}

async function claimAndMint() {
  await authorizeClaimTx();
  return mintTx();
}

describe('minting without a claim', () => {
  /// The single most important test in the repository: an unclaimed mint must
  /// be impossible, or the bridge can print unbacked supply.
  it('is refused', async () => {
    await expect(
      Mina.transaction(deployer, async () => {
        AccountUpdate.fundNewAccount(deployer, 1);
        await token.mint(recipient, AMOUNT);
      }).then((t) => t.prove()),
    ).rejects.toThrow();
  }, 300_000);

  it('is refused even with the attestor signing', async () => {
    // The attestor is the one trusted key in the system. It must still not be
    // able to mint: its only power is publishing a lock root.
    const tx = await Mina.transaction(deployer, async () => {
      await admin.publishLockRoot(lockTree.getRoot());
    });
    await tx.prove();
    await tx.sign([deployerKey, attestorKey]).send();

    await expect(mintTx()).rejects.toThrow(/no mint is authorised/);
  }, 300_000);
});

describe('claim then mint', () => {
  it('mints exactly the claimed amount to the claimed recipient', async () => {
    await claimAndMint();

    const balance = (await token.getBalanceOf(recipient)).toBigInt();
    expect(balance).toBe(AMOUNT.toBigInt());
    expect((await token.getCirculating()).toBigInt()).toBe(AMOUNT.toBigInt());
  }, 300_000);

  it('disarms the authorisation once the mint is consumed', async () => {
    await claimAndMint();
    expect(admin.mintAuthorization.get().toString()).toBe(NO_MINT_AUTHORIZED.toString());
  }, 300_000);

  it('refuses a second mint on the same authorisation', async () => {
    await claimAndMint();
    await expect(mintTx(recipient, AMOUNT, false)).rejects.toThrow(/no mint is authorised/);
  }, 300_000);

  it('refuses a mint of a different amount than the claim', async () => {
    await authorizeClaimTx();
    // The claim is genuine; the amount is not the one claimed.
    await expect(mintTx(recipient, AMOUNT.add(UInt64.one))).rejects.toThrow(
      /mint does not match the claim/,
    );
  }, 300_000);

  it('refuses a mint to a different recipient than the claim', async () => {
    const thief = PrivateKey.random().toPublicKey();

    await authorizeClaimTx();
    await expect(mintTx(thief, AMOUNT)).rejects.toThrow(/mint does not match the claim/);
  }, 300_000);
});
