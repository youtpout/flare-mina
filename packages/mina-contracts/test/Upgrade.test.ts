import { beforeAll, describe, expect, it } from 'vitest';
import { AccountUpdate, Field, Mina, PrivateKey, PublicKey, UInt64, VerificationKey } from 'o1js';
import { MinaPortBridge, flareRecipientField } from '../src/MinaPortBridge.js';
import { SigningPolicyFold } from '../src/SigningPolicyFold.js';
import { WithdrawalChain } from '../src/WithdrawalChain.js';

/**
 * Upgrading the escrow zkApp.
 *
 * Mina has no proxies. Upgrading means replacing the account's verification key,
 * which keeps the address, the balance and the eight state fields — everything
 * a redeploy would abandon.
 *
 * These run with `proofsEnabled: false`, so what they pin is the authorisation
 * rule and the state survival, not the proof machinery.
 */

const MINA = 1_000_000_000n;

let deployerKey: PrivateKey;
let deployer: PublicKey;
let adminKey: PrivateKey;
let admin: PublicKey;
let userKey: PrivateKey;
let user: PublicKey;
let zkAppKey: PrivateKey;
let zkAppAddress: PublicKey;
let bridge: MinaPortBridge;
let vk: VerificationKey;

beforeAll(async () => {
  const Local = await Mina.LocalBlockchain({ proofsEnabled: false });
  Mina.setActiveInstance(Local);

  deployerKey = Local.testAccounts[0].key;
  deployer = deployerKey.toPublicKey();
  adminKey = Local.testAccounts[1].key;
  admin = adminKey.toPublicKey();
  userKey = Local.testAccounts[2].key;
  user = userKey.toPublicKey();

  // Compiled for real, unlike the rest of this file: the upgrade installs an
  // actual verification key, and `proofsEnabled: false` produces none. The
  // contract verifies proofs from both programs, so their keys must exist
  // before its own can be built.
  await WithdrawalChain.compile();
  await SigningPolicyFold.compile();
  ({ verificationKey: vk } = await MinaPortBridge.compile());

  zkAppKey = PrivateKey.random();
  zkAppAddress = zkAppKey.toPublicKey();
  bridge = new MinaPortBridge(zkAppAddress);

  const tx = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer);
    await bridge.deploy({ admin, withdrawalAttestor: admin, signingPolicyRoot: Field(7) });
  });
  await tx.prove();
  await tx.sign([deployerKey, zkAppKey]).send();

  // Real state to lose: escrowed MINA and a configured policy.
  const deposit = await Mina.transaction(user, async () => {
    await bridge.deposit(
      UInt64.from(1n),
      flareRecipientField('0x1111111111111111111111111111111111111111'),
      UInt64.from(4n * MINA),
    );
  });
  await deposit.prove();
  await deposit.sign([userKey]).send();
}, 1_800_000);

/**
 * Install a verification key by signature.
 *
 * No contract method is involved: the account's own key authorises the change
 * directly. That is the whole reason this is the signature variant — a
 * proof-gated upgrade would need an `upgrade` circuit deployed in advance, so
 * it could never repair the deployment that shipped without one.
 */
async function upgrade(signers: PrivateKey[]) {
  const tx = await Mina.transaction(deployer, async () => {
    const update = AccountUpdate.createSigned(zkAppAddress);
    update.account.verificationKey.set(vk);
  });
  await tx.prove();
  return tx.sign([deployerKey, ...signers]).send();
}

describe('upgrading the escrow', () => {
  it("refuses without the zkApp key's signature", async () => {
    await expect(upgrade([])).rejects.toThrow();
  }, 600_000);

  /**
   * The reason upgradability exists here. A redeploy would leave this balance
   * at an address whose circuits no longer run.
   */
  it('keeps the address, the escrow and the state', async () => {
    const balanceBefore = Mina.getBalance(zkAppAddress).toBigInt();
    expect(balanceBefore).toBe(4n * MINA);

    await upgrade([zkAppKey]);

    expect(Mina.getBalance(zkAppAddress).toBigInt()).toBe(balanceBefore);
    expect(bridge.signingPolicyRoot.get().toString()).toBe('7');
    expect(bridge.admin.get().toBase58()).toBe(admin.toBase58());
    expect(bridge.processedActionState.get().toString()).toBe('0');
  }, 600_000);

  /** The account still works afterwards, rather than merely still existing. */
  it('leaves the contract usable', async () => {
    const tx = await Mina.transaction(user, async () => {
      await bridge.deposit(
        UInt64.from(2n),
        flareRecipientField('0x2222222222222222222222222222222222222222'),
        UInt64.from(MINA),
      );
    });
    await tx.prove();
    await tx.sign([userKey]).send();

    expect(Mina.getBalance(zkAppAddress).toBigInt()).toBe(5n * MINA);
  }, 600_000);
});
