import { beforeAll, describe, expect, it } from 'vitest';
import { AccountUpdate, Field, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';
import {
  DepositAction,
  MinaPortBridge,
  WithdrawalRecord,
  flareRecipientField,
  flareRecipientHex,
} from '../src/MinaPortBridge.js';

const MINA = 1_000_000_000n;

const RECIPIENT_A = '0x1111111111111111111111111111111111111111';
const RECIPIENT_B = '0x2222222222222222222222222222222222222222';

let deployerKey: PrivateKey;
let deployer: PublicKey;
let userKey: PrivateKey;
let user: PublicKey;
let attestorKey: PrivateKey;
let attestor: PublicKey;
let zkAppKey: PrivateKey;
let zkAppAddress: PublicKey;
let bridge: MinaPortBridge;

beforeAll(async () => {
  const Local = await Mina.LocalBlockchain({ proofsEnabled: false });
  Mina.setActiveInstance(Local);

  deployerKey = Local.testAccounts[0].key;
  deployer = deployerKey.toPublicKey();
  userKey = Local.testAccounts[1].key;
  user = userKey.toPublicKey();
  attestorKey = Local.testAccounts[2].key;
  attestor = attestorKey.toPublicKey();

  zkAppKey = PrivateKey.random();
  zkAppAddress = zkAppKey.toPublicKey();
  bridge = new MinaPortBridge(zkAppAddress);

  const deployTx = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer);
    await bridge.deploy({ admin: deployer, withdrawalAttestor: attestor });
  });
  await deployTx.prove();
  await deployTx.sign([deployerKey, zkAppKey]).send();

}, 120_000);

async function deposit(
  from: PrivateKey,
  expectedNonce: bigint,
  recipient: string,
  amountNanomina: bigint,
) {
  const tx = await Mina.transaction(from.toPublicKey(), async () => {
    await bridge.deposit(
      UInt64.from(expectedNonce),
      flareRecipientField(recipient),
      UInt64.from(amountNanomina),
    );
  });
  await tx.prove();
  return tx.sign([from]).send();
}

describe('deposit', () => {
  it('locks MINA, assigns the nonce and advances the action state', async () => {
    const stateBefore = bridge.depositActionState.get();
    const lockedBefore = bridge.lockedNanomina.get();
    const balanceBefore = Mina.getBalance(zkAppAddress);

    await deposit(userKey, 0n, RECIPIENT_A, 3n * MINA);

    expect(bridge.nextDepositNonce.get().toBigInt()).toBe(1n);
    expect(bridge.lockedNanomina.get().toBigInt()).toBe(lockedBefore.toBigInt() + 3n * MINA);
    expect(Mina.getBalance(zkAppAddress).toBigInt()).toBe(balanceBefore.toBigInt() + 3n * MINA);

    // The new action state must equal the off-chain recomputation.
    const expected = MinaPortBridge.advanceActionState(stateBefore, [
      new DepositAction({
        nonce: UInt64.zero,
        senderX: user.x,
        senderIsOdd: user.isOdd,
        flareRecipient: flareRecipientField(RECIPIENT_A),
        amount: UInt64.from(3n * MINA),
      }),
    ]);
    expect(bridge.depositActionState.get().toString()).toBe(expected.toString());
  }, 120_000);

  it('binds the exact Flare recipient into the action', async () => {
    const action = new DepositAction({
      nonce: UInt64.zero,
      senderX: user.x,
      senderIsOdd: user.isOdd,
      flareRecipient: flareRecipientField(RECIPIENT_A),
      amount: UInt64.from(MINA),
    });
    const other = new DepositAction({ ...action, flareRecipient: flareRecipientField(RECIPIENT_B) });
    expect(action.hash().toString()).not.toBe(other.hash().toString());
  });

  it('rejects a zero amount', async () => {
    await expect(deposit(userKey, 1n, RECIPIENT_A, 0n)).rejects.toThrow(/non-zero/);
  }, 120_000);

  it('rejects a duplicate/replayed nonce', async () => {
    // Nonce 0 was consumed by the first test; re-submitting it must fail.
    await expect(deposit(userKey, 0n, RECIPIENT_A, MINA)).rejects.toThrow(/unexpected deposit nonce/);
  }, 120_000);

  it('rejects a recipient that does not fit in 160 bits', async () => {
    const tooBig = Field((1n << 160n) + 1n);
    const tx = Mina.transaction(user, async () => {
      await bridge.deposit(UInt64.from(1n), tooBig, UInt64.from(MINA));
    });
    await expect(tx.then((t) => t.prove())).rejects.toThrow(/160 bits/);
  }, 120_000);

  it('rejects an out-of-range recipient at the encoding boundary', () => {
    expect(() => flareRecipientField(1n << 160n)).toThrow(/160-bit range/);
    expect(() => flareRecipientField(-1n)).toThrow(/160-bit range/);
    expect(flareRecipientHex(flareRecipientField(RECIPIENT_A))).toBe(RECIPIENT_A);
  });

  it('keeps the action state consistent across several deposits', async () => {
    const stateBefore = bridge.depositActionState.get();
    const startNonce = bridge.nextDepositNonce.get().toBigInt();

    await deposit(userKey, startNonce, RECIPIENT_A, MINA);
    await deposit(userKey, startNonce + 1n, RECIPIENT_B, 2n * MINA);

    const expected = MinaPortBridge.advanceActionState(stateBefore, [
      new DepositAction({
        nonce: UInt64.from(startNonce),
        senderX: user.x,
        senderIsOdd: user.isOdd,
        flareRecipient: flareRecipientField(RECIPIENT_A),
        amount: UInt64.from(MINA),
      }),
      new DepositAction({
        nonce: UInt64.from(startNonce + 1n),
        senderX: user.x,
        senderIsOdd: user.isOdd,
        flareRecipient: flareRecipientField(RECIPIENT_B),
        amount: UInt64.from(2n * MINA),
      }),
    ]);
    expect(bridge.depositActionState.get().toString()).toBe(expected.toString());
  }, 180_000);
});

describe('withdrawal release', () => {
  async function release(record: WithdrawalRecord, signers: PrivateKey[]) {
    const tx = await Mina.transaction(deployer, async () => {
      await bridge.releaseWithdrawal(record);
    });
    await tx.prove();
    return tx.sign([deployerKey, ...signers]).send();
  }

  it('requires the attestor signature', async () => {
    const record = new WithdrawalRecord({
      nonce: UInt64.from(1n),
      recipient: user,
      amount: UInt64.from(MINA),
    });
    await expect(release(record, [])).rejects.toThrow();
  }, 120_000);

  it('releases MINA and advances the withdrawal nonce', async () => {
    const balanceBefore = Mina.getBalance(user);
    const lockedBefore = bridge.lockedNanomina.get().toBigInt();

    await release(
      new WithdrawalRecord({ nonce: UInt64.from(1n), recipient: user, amount: UInt64.from(MINA) }),
      [attestorKey],
    );

    expect(bridge.lastWithdrawalNonce.get().toBigInt()).toBe(1n);
    expect(bridge.lockedNanomina.get().toBigInt()).toBe(lockedBefore - MINA);
    expect(Mina.getBalance(user).toBigInt()).toBe(balanceBefore.toBigInt() + MINA);
  }, 120_000);

  it('rejects a replayed withdrawal nonce', async () => {
    await expect(
      release(
        new WithdrawalRecord({ nonce: UInt64.from(1n), recipient: user, amount: UInt64.from(MINA) }),
        [attestorKey],
      ),
    ).rejects.toThrow(/strictly increasing/);
  }, 120_000);

  it('rejects a withdrawal exceeding escrowed collateral', async () => {
    await expect(
      release(
        new WithdrawalRecord({
          nonce: UInt64.from(2n),
          recipient: user,
          amount: UInt64.from(1_000_000n * MINA),
        }),
        [attestorKey],
      ),
    ).rejects.toThrow(/collateral/);
  }, 120_000);
});

describe('attestor rotation', () => {
  it('separates admin from attestor: the admin can rotate, and only the admin', async () => {
    const fresh = PrivateKey.random().toPublicKey();

    // A non-admin cannot rotate, even with a valid proof: the admin's account
    // update is unsigned.
    const bad = await Mina.transaction(user, async () => {
      await bridge.setWithdrawalAttestor(fresh);
    });
    await bad.prove();
    await expect(bad.sign([userKey]).send()).rejects.toThrow();

    // The admin can.
    const good = await Mina.transaction(deployer, async () => {
      await bridge.setWithdrawalAttestor(fresh);
    });
    await good.prove();
    await good.sign([deployerKey]).send();

    expect(bridge.withdrawalAttestor.get().toBase58()).toBe(fresh.toBase58());
  }, 180_000);
});
