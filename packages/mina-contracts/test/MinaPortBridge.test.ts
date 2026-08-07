import { beforeAll, describe, expect, it } from 'vitest';
import {
  AccountUpdate,
  Field,
  MerkleTree,
  Mina,
  PrivateKey,
  PublicKey,
  UInt32,
  UInt64,
} from 'o1js';
import {
  WithdrawalChain,
  type WithdrawalChainProof,
  applyWithdrawal,
} from '../src/WithdrawalChain.js';
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
import {
  DepositAction,
  DepositEvent,
  MinaPortBridge,
  WithdrawalRecord,
  flareRecipientField,
  flareRecipientHex,
} from '../src/MinaPortBridge.js';

const MINA = 1_000_000_000n;

/** The Flare bridge this escrow accepts events from, and the `WithdrawToMina` signature. */
const FLARE_BRIDGE = Field(BigInt('0x871493412EDCcfE0d24f127E6Deb2B20AE5497aB'));
const TOPIC0 = BigInt('0x1e0b6b1f6b2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5');

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
let policyTree: MerkleTree;
let validatorKey: bigint;

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

  // A one-validator signing policy. `requiredWeight` stays zero, so what is
  // exercised here is the binding, not the threshold.
  validatorKey = Secp256k1.Scalar.random().toBigInt();
  const publicKey = Secp256k1.generator.scale(validatorKey);
  policyTree = new MerkleTree(POLICY_TREE_HEIGHT);
  policyTree.setLeaf(0n, policyLeaf(publicKey, UInt32.from(0), UInt32.from(1)));

  const deployTx = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer);
    await bridge.deploy({
      admin: deployer,
      flareBridge: FLARE_BRIDGE,
      signingPolicyRoot: policyTree.getRoot(),
    });
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
  /**
   * The chain Flare would have built. States are computed the same way
   * `burnToMina` computes them, so these are the exact values the contract has
   * to land on.
   */
  let w1: WithdrawalRecord;
  let s1: Field;
  let w2: WithdrawalRecord;
  let s2: Field;

  beforeAll(async () => {
    await WithdrawalChain.compile({ proofsEnabled: false });
    await RelayMessage.compile({ proofsEnabled: false });
    await SigningPolicyFold.compile({ proofsEnabled: false });
    await MerkleInclusion.compile({ proofsEnabled: false });
    await FdcLeaf.compile({ proofsEnabled: false });
    await FdcAttestation.compile({ proofsEnabled: false });

    // Built here, not at describe scope: `user` is only assigned in the outer
    // beforeAll, which has not run when the describe body is evaluated.
    w1 = new WithdrawalRecord({
      nonce: UInt64.from(1n),
      recipient: user,
      amount: UInt64.from(MINA),
    });
    s1 = applyWithdrawal(Field(0), w1);
    w2 = new WithdrawalRecord({
      nonce: UInt64.from(2n),
      recipient: user,
      amount: UInt64.from(2n * MINA),
    });
    s2 = applyWithdrawal(s1, w2);
  }, 300_000);

  /**
   * Build the attestation Flare would produce for a `WithdrawToMina` carrying
   * `actionState`: an event, hashed into a leaf, in a round tree whose root the
   * validator signs.
   */
  async function attestationFor(actionState: Field, opts: { emitter?: Field; protocol?: string } = {}) {
    const response = new Uint8Array(1344);
    const putWord = (word: number, value: bigint) => {
      for (let i = 0; i < 32; i++) {
        response[word * 32 + 31 - i] = Number((value >> BigInt(8 * i)) & 0xffn);
      }
    };
    putWord(28, (opts.emitter ?? FLARE_BRIDGE).toBigInt());
    putWord(33, TOPIC0);
    putWord(41, actionState.toBigInt());

    const leafHex = keccak256(`0x${Buffer.from(response).toString('hex')}` as `0x${string}`);
    const siblingHex = keccak256('0xdeadbeef');
    const [lo, hi] =
      leafHex.toLowerCase() < siblingHex.toLowerCase()
        ? [leafHex, siblingHex]
        : [siblingHex, leafHex];
    const rootHex = keccak256(`0x${lo.slice(2)}${hi.slice(2)}` as `0x${string}`);

    const { proof: relay } = await RelayMessage.bind(
      Bytes38.fromHex((opts.protocol ?? 'c8') + '0015a2b401' + rootHex.slice(2)),
    );
    const { proof: policy } = await SigningPolicyFold.single(relay, policyTree.getRoot(), {
      publicKey: Secp256k1.generator.scale(validatorKey),
      signature: EcdsaSignature.signHash(
        Bytes32.from(relay.publicOutput.digest.bytes),
        validatorKey,
      ),
      index: UInt32.from(0),
      weight: UInt32.from(1),
      witness: new PolicyWitness(policyTree.getWitness(0n)),
    } as never);

    const { proof: inclusion } = await MerkleInclusion.level(
      Bytes32.fromHex(leafHex.slice(2)),
      Bytes32.fromHex(siblingHex.slice(2)),
    );
    const { proof: leaf } = await FdcLeaf.read(AttestationResponse.from(response), inclusion);
    return (await FdcAttestation.attest(leaf, policy)).proof;
  }

  async function publish(actionState: Field) {
    const attestation = await attestationFor(actionState);
    const tx = await Mina.transaction(deployer, async () => {
      await bridge.publishFlareActionState(attestation);
    });
    await tx.prove();
    // Only the fee payer signs. Nothing here asserts the state.
    return tx.sign([deployerKey]).send();
  }

  /**
   * The property the co-signature used to stand in for: the state comes out of
   * the attested event, so a caller cannot name one.
   */
  it('takes the state from the attested event', async () => {
    await publish(s2);
    expect(bridge.flareActionState.get().toString()).toBe(s2.toString());
  }, 600_000);

  /** FDC rounds carry attestation roots; other protocols carry other things. */
  it('refuses a round that is not FDC', async () => {
    const attestation = await attestationFor(s2, { protocol: '64' });
    await expect(
      Mina.transaction(deployer, async () => {
        await bridge.publishFlareActionState(attestation);
      }),
    ).rejects.toThrow(/not an FDC round/);
  }, 600_000);

  /**
   * An attestation proves an event happened, not that it was ours. Without the
   * emitter check, any contract could emit a `WithdrawToMina` and move the
   * escrow's cursor.
   */
  it('refuses an event from another contract', async () => {
    const attestation = await attestationFor(s2, { emitter: Field(0xdeadn) });
    await expect(
      Mina.transaction(deployer, async () => {
        await bridge.publishFlareActionState(attestation);
      }),
    ).rejects.toThrow(/came from another contract/);
  }, 600_000);

  async function release(record: WithdrawalRecord, tail: WithdrawalChainProof) {
    const tx = await Mina.transaction(deployer, async () => {
      await bridge.releaseWithdrawal(record, tail);
    });
    await tx.prove();
    return tx.sign([deployerKey]).send();
  }

  it('publishes the attested Flare state', async () => {
    await publish(s2);
    expect(bridge.flareActionState.get().toString()).toBe(s2.toString());
  }, 300_000);

  /**
   * The property the design rests on: the record is untrusted input, and what
   * constrains it is that no other record has a continuation reaching the
   * attested state.
   */
  it('refuses a fabricated withdrawal', async () => {
    const fake = new WithdrawalRecord({
      nonce: UInt64.from(1n),
      recipient: deployer,
      amount: UInt64.from(MINA),
    });
    const { proof: tail } = await WithdrawalChain.link(applyWithdrawal(Field(0), fake), w2);

    await expect(release(fake, tail)).rejects.toThrow(/does not reach the attested/);
  }, 300_000);

  /** Same withdrawal, altered amount — the amount is inside the hash. */
  it('refuses a withdrawal whose amount was changed', async () => {
    const altered = new WithdrawalRecord({
      nonce: UInt64.from(1n),
      recipient: user,
      amount: UInt64.from(5n * MINA),
    });
    const { proof: tail } = await WithdrawalChain.link(s1, w2);

    await expect(release(altered, tail)).rejects.toThrow(/does not continue/);
  }, 300_000);

  it('releases the first withdrawal and advances the cursor', async () => {
    const balanceBefore = Mina.getBalance(user).toBigInt();
    const escrowBefore = Mina.getBalance(zkAppAddress).toBigInt();

    const { proof: tail } = await WithdrawalChain.link(s1, w2);
    await release(w1, tail);

    expect(bridge.processedActionState.get().toString()).toBe(s1.toString());
    expect(Mina.getBalance(zkAppAddress).toBigInt()).toBe(escrowBefore - MINA);
    expect(Mina.getBalance(user).toBigInt()).toBe(balanceBefore + MINA);
  }, 300_000);

  /** The newest withdrawal has an empty tail — that is what `empty` is for. */
  it('releases the last withdrawal against an empty tail', async () => {
    const { proof: tail } = await WithdrawalChain.empty(s2);
    await release(w2, tail);

    expect(bridge.processedActionState.get().toString()).toBe(s2.toString());
  }, 300_000);

  /**
   * Replay protection now comes from the cursor rather than a stored nonce.
   * The cursor sits at s2, so folding w1 onto it lands somewhere the old tail
   * does not begin — the release is refused because the two no longer meet.
   */
  it('refuses a replayed withdrawal', async () => {
    const { proof: tail } = await WithdrawalChain.link(s1, w2);
    await expect(release(w1, tail)).rejects.toThrow(/does not continue/);
  }, 300_000);
});

describe('signing policy rotation', () => {
  /**
   * Not administrative housekeeping: Coston2 rotates its validator set every
   * 6 hours, so a root fixed at deploy stops accepting proofs the same day.
   */
  it('lets the admin rotate the root, and only the admin', async () => {
    const fresh = Field(123456789n);

    // The admin here is `deployer`, so a transaction it never signs must fail.
    const rejected = await Mina.transaction(user, async () => {
      await bridge.setSigningPolicyRoot(fresh);
    });
    await rejected.prove();
    await expect(rejected.sign([userKey]).send()).rejects.toThrow();

    const tx = await Mina.transaction(deployer, async () => {
      await bridge.setSigningPolicyRoot(fresh);
    });
    await tx.prove();
    await tx.sign([deployerKey]).send();

    expect(bridge.signingPolicyRoot.get().toString()).toBe(fresh.toString());
  }, 300_000);
});

