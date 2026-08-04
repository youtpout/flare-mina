import { beforeAll, describe, expect, it } from 'vitest';
import { AccountUpdate, Field, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';
import {
  DepositAction,
  DepositEvent,
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
  nonce: bigint,
  recipient: string,
  amountNanomina: bigint,
) {
  const tx = await Mina.transaction(from.toPublicKey(), async () => {
    await bridge.deposit(
      UInt64.from(nonce),
      flareRecipientField(recipient),
      UInt64.from(amountNanomina),
    );
  });
  await tx.prove();
  return tx.sign([from]).send();
}

/** Deposit actions dispatched so far, newest batch last. */
async function dispatchedActions() {
  const actions = await bridge.reducer.fetchActions();
  return actions.flat();
}

describe('deposit', () => {
  it('escrows the MINA and dispatches the action', async () => {
    const balanceBefore = Mina.getBalance(zkAppAddress);

    await deposit(userKey, 0n, RECIPIENT_A, 3n * MINA);

    // The account balance IS the escrowed total: with `receive: proof()` it
    // cannot move except through these methods, which is why the contract
    // keeps no separate figure.
    expect(Mina.getBalance(zkAppAddress).toBigInt()).toBe(balanceBefore.toBigInt() + 3n * MINA);

    const actions = await dispatchedActions();
    expect(actions).toHaveLength(1);
    const [only] = actions as [DepositAction];
    expect(only.nonce.toBigInt()).toBe(0n);
    expect(only.amount.toBigInt()).toBe(3n * MINA);
    expect(only.senderX.toString()).toBe(user.x.toString());
    expect(flareRecipientHex(only.flareRecipient)).toBe(RECIPIENT_A);
  }, 120_000);

  /**
   * The escrow must refuse an ordinary payment.
   *
   * A plain payment credits the balance without running `deposit`, so no action
   * is ever dispatched and nothing on Flare can claim it — while the balance,
   * which is now the escrow accounting, silently overstates what was actually
   * bridged. `receive: proof()` turns that into a rejected transaction, the
   * only outcome that leaves the sender's MINA usable. Learned from 30 MINA
   * stranded on devnet.
   */
  it('refuses a plain payment, so funds cannot bypass the accounting', async () => {
    const balanceBefore = Mina.getBalance(zkAppAddress).toBigInt();
    const actionsBefore = (await dispatchedActions()).length;

    const tx = await Mina.transaction(user, async () => {
      const from = AccountUpdate.createSigned(user);
      from.send({ to: zkAppAddress, amount: UInt64.from(MINA) });
    });
    await tx.prove();
    await expect(tx.sign([userKey]).send()).rejects.toThrow();

    expect(Mina.getBalance(zkAppAddress).toBigInt()).toBe(balanceBefore);
    expect(await dispatchedActions()).toHaveLength(actionsBefore);
  }, 120_000);

  /**
   * The event is a journal, not the machine — but an unread journal is worse
   * than none, so it gets a test rather than a comment.
   *
   * It carries the same facts as the action, in a form that needs no hash-chain
   * decoding: a watcher that has not implemented the action encoding can still
   * see who deposited what, for whom.
   */
  it('emits a readable deposit event alongside the action', async () => {
    await deposit(userKey, 42n, RECIPIENT_B, 4n * MINA);

    // Located by its nonce rather than by position: `fetchEvents` makes no
    // ordering promise this test should depend on.
    const emitted = (await bridge.fetchEvents())
      .filter((e) => e.type === 'deposit')
      .map((e) => e.event.data as unknown as DepositEvent)
      .find((d) => d.nonce.toBigInt() === 42n);

    expect(emitted, 'no deposit event carrying nonce 42').toBeDefined();
    expect(emitted!.amount.toBigInt()).toBe(4n * MINA);
    expect(emitted!.sender.toBase58()).toBe(user.toBase58());
    expect(flareRecipientHex(emitted!.flareRecipient)).toBe(RECIPIENT_B);
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

  /**
   * The nonce is the caller's to choose, and the contract does not police it.
   *
   * Worth pinning as a test rather than leaving to a comment: reusing a nonce
   * is accepted here, and the consequence lands on Flare, where
   * `consumedIntents` keys on `(sender, recipient, amount, nonce)` and would
   * see the second deposit as already claimed. Enforcing sequentiality on-chain
   * would serialise every depositor against every other, which is a real cost
   * for a constraint only the depositor can violate and only they pay for.
   */
  it('does not police the nonce — uniqueness is the caller obligation', async () => {
    const before = (await dispatchedActions()).length;

    await deposit(userKey, 7n, RECIPIENT_A, MINA);
    await deposit(userKey, 7n, RECIPIENT_A, MINA);

    const actions = await dispatchedActions();
    expect(actions).toHaveLength(before + 2);
    expect(actions.slice(-2).map((a) => a.nonce.toBigInt())).toEqual([7n, 7n]);
  }, 180_000);

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

  it('records each deposit as its own action, in order', async () => {
    const before = (await dispatchedActions()).length;
    const balanceBefore = Mina.getBalance(zkAppAddress).toBigInt();

    await deposit(userKey, 100n, RECIPIENT_A, MINA);
    await deposit(userKey, 101n, RECIPIENT_B, 2n * MINA);

    const actions = await dispatchedActions();
    expect(actions).toHaveLength(before + 2);

    const [first, second] = actions.slice(-2) as [DepositAction, DepositAction];
    expect(flareRecipientHex(first.flareRecipient)).toBe(RECIPIENT_A);
    expect(first.amount.toBigInt()).toBe(MINA);
    expect(flareRecipientHex(second.flareRecipient)).toBe(RECIPIENT_B);
    expect(second.amount.toBigInt()).toBe(2n * MINA);

    expect(Mina.getBalance(zkAppAddress).toBigInt()).toBe(balanceBefore + 3n * MINA);
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
    const escrowBefore = Mina.getBalance(zkAppAddress).toBigInt();

    await release(
      new WithdrawalRecord({ nonce: UInt64.from(1n), recipient: user, amount: UInt64.from(MINA) }),
      [attestorKey],
    );

    expect(bridge.lastWithdrawalNonce.get().toBigInt()).toBe(1n);
    // The escrow shrinks by exactly the released amount — no separate figure
    // to keep in step with it.
    expect(Mina.getBalance(zkAppAddress).toBigInt()).toBe(escrowBefore - MINA);
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

  /**
   * The collateral bound is now a precondition on the account balance rather
   * than an in-circuit assertion against a stored total, so the refusal comes
   * from the protocol and reads `Account_balance_precondition_unsatisfied`
   * instead of a message we wrote.
   *
   * That is a worse error string and a better check: it tests the real balance
   * rather than a number the contract maintains and could get out of step with,
   * and being a range rather than an equality it survives a deposit landing in
   * the same block.
   */
  it('rejects a withdrawal exceeding the escrowed balance', async () => {
    await expect(
      release(
        new WithdrawalRecord({
          nonce: UInt64.from(2n),
          recipient: user,
          amount: UInt64.from(1_000_000n * MINA),
        }),
        [attestorKey],
      ),
    ).rejects.toThrow(/Account_balance_precondition_unsatisfied/);
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
