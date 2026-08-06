// Bounds the public Mina endpoint's intermittent 60s stalls, which land on
// roughly one request in three and answer 200 a minute later. Inlined rather
// than imported from `../resilientFetch.ts`: this file is loaded as a worker
// entry, where the loader does not rewrite `.js` specifiers to `.ts`. Fifteen
// duplicated lines beat fighting the resolver. See that file for the
// measurements and for what was ruled out.
//
// Must run before anything fetches — o1js included, since `fetchAccount` and
// transaction building are exactly the calls that stall.
{
  const original = globalThis.fetch;
  const timeoutMs = Number(process.env.HTTP_TIMEOUT_MS ?? 2_500);
  const attempts = Number(process.env.HTTP_ATTEMPTS ?? 5);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = init?.signal != null ? AbortSignal.any([init.signal, timeout]) : timeout;
        return await original(input, { ...init, signal });
      } catch (error) {
        last = error;
        if (init?.signal?.aborted) throw error;
      }
    }
    throw last;
  };
}

import { parentPort } from 'node:worker_threads';
import {
  setBackend,
  initializeBindings,
  AccountUpdate,
  Cache,
  Mina,
  PrivateKey,
  PublicKey,
  UInt32,
  UInt64,
  fetchAccount,
  Field,
} from 'o1js';
// Types only — erased at build, so they cost the worker no resolution.
import type { PolicyKey, RelayCall } from '@minaport/shared';

/**
 * Builds and proves `MinaPortBridge.deposit` transactions.
 *
 * # Why the relayer proves
 *
 * A zkApp method call is a proof, so o1js has to run somewhere. Putting it in
 * the browser would mean shipping o1js in the bundle and proving on the user's
 * machine; putting it here costs nothing in trust, because the transaction this
 * worker returns is **unsigned**. `deposit` pulls funds through
 * `AccountUpdate.createSigned(sender)`, so nothing moves until the depositor's
 * wallet signs that exact account update. A dishonest relayer can build a
 * transaction the user refuses to sign, and that is all.
 *
 * The frontend still checks the recipient and amount in the returned JSON
 * before handing it to the wallet — see `apps/web`. Cheap, and it removes the
 * "did the server put the right address in the proof" question entirely.
 *
 * # Why a worker thread
 *
 * Proving takes ~2.3 s of solid CPU, and with `@o1js/native` it blocks the
 * calling thread outright — the addon is a synchronous NAPI call, unlike the
 * wasm build which uses its own pool. On the main thread that would freeze
 * every request, including `/health`, for the duration. Here it freezes only
 * this worker.
 *
 * Requests are handled one at a time by construction (one worker, messages
 * processed in order). Two concurrent proofs would fight for the same cores and
 * both would take longer.
 */

const CACHE_DIR = process.env.O1JS_CACHE_DIR;

type BuildRequest = {
  kind: 'deposit';
  id: number;
  sender: string;
  recipient: `0x${string}`;
  amountNanomina: string;
  nonce: string;
};

/**
 * Release escrowed MINA against a burn that already happened on Flare.
 *
 * Unlike a deposit, this transaction is proved *and signed* here: the user has
 * nothing to sign, their FMINA is already gone.
 *
 * `tail` is every withdrawal Flare committed to *after* this one, up to the
 * state the zkApp has accepted. It is what proves this record is genuinely the
 * next link in Flare's chain rather than something the relayer made up — no
 * other record has a continuation reaching that state. The relayer therefore
 * cannot invent, redirect or resize a withdrawal, which is what the attestor
 * co-signature used to be standing in for.
 */
type ReleaseRequest = {
  kind: 'release';
  id: number;
  nonce: string;
  recipient: string;
  amountNanomina: string;
  /** Subsequent withdrawals, in Flare's order. Empty when this is the newest. */
  tail: Array<{ nonce: string; recipient: string; amountNanomina: string }>;
};

/**
 * Push Flare's withdrawal chain state to the escrow.
 *
 * `calls` are recent `Relay.relay()` transactions: the signing policy and the
 * validator signatures both come out of their calldata, and nowhere else.
 */
type PublishRequest = {
  kind: 'publish';
  id: number;
  actionState: string;
  calls: unknown[];
  keys: unknown[];
};

type Request = BuildRequest | ReleaseRequest | PublishRequest;

type Ready = { type: 'ready'; compileMs: number };
type Built = { type: 'built'; id: number; transaction: string; provingMs: number };
type Failed = { type: 'failed'; id: number; error: string };

if (parentPort === null) throw new Error('prover worker must be started as a worker thread');
const port = parentPort;

// The native backend is ~1.8x faster than wasm on this circuit and is a single
// npm package. See packages/native-prover for the measurements.
setBackend('native');
await initializeBindings();

// Imported from the built output rather than the package root. The root
// entry is TypeScript source whose relative imports use `.js` extensions,
// which this worker's loader does not rewrite — the contracts package must be
// built (`pnpm --filter @minaport/mina-contracts build`) before the relayer
// starts.
// From dist, like the contracts below: a worker thread has no tsx loader, so a
// source import would resolve to .ts files whose own .js specifiers do not exist.
const { signedMessageHash } = await import('@minaport/shared/dist/src/flareRelay.js');
const { WithdrawalChain, applyWithdrawal } = await import(
  '@minaport/mina-contracts/dist/src/WithdrawalChain.js'
);
const { SigningPolicyFold, EcdsaSignature, Bytes32 } = await import(
  '@minaport/mina-contracts/dist/src/SigningPolicyFold.js'
);
const { buildPolicyTree, toSecp256k1 } = await import(
  '@minaport/mina-contracts/dist/src/policyTree.js'
);
const { MinaPortBridge, WithdrawalRecord, flareRecipientField } = await import(
  '@minaport/mina-contracts/dist/src/MinaPortBridge.js'
);

const bridgeAddress = process.env.MINA_BRIDGE_ACCOUNT;
if (!bridgeAddress) throw new Error('MINA_BRIDGE_ACCOUNT is not set');

const graphql = process.env.MINA_GRAPHQL ?? 'https://mina-devnet-graphql.aurowallet.com/graphql';
// Both endpoints, explicitly. Given only a node URL, o1js leaves the archive
// endpoint at its default and something in transaction building reaches for
// it — which cost a flat 60s per deposit, the exact timeout of the public
// archive that has been returning 504 all day. Pointing archive at the node
// makes that call fail in milliseconds instead of hanging.
//
// Nothing here needs archive data: the relayer builds its own deposits, so it
// has no actions to read back.
Mina.setActiveInstance(Mina.Network({ mina: graphql, archive: graphql }));

// Compile once, at start-up. A cold compile rebuilds the SRS and Lagrange
// bases and costs seconds; a warm one reads them back. Mount O1JS_CACHE_DIR on
// a volume so a redeploy does not pay for it again.
const compileStart = Date.now();
// The chain program first: the contract verifies its proofs, so its
// verification key has to exist before the contract compiles.
await WithdrawalChain.compile(CACHE_DIR ? { cache: Cache.FileSystem(CACHE_DIR) } : {});
await SigningPolicyFold.compile(CACHE_DIR ? { cache: Cache.FileSystem(CACHE_DIR) } : {});
await MinaPortBridge.compile(CACHE_DIR ? { cache: Cache.FileSystem(CACHE_DIR) } : {});
port.postMessage({ type: 'ready', compileMs: Date.now() - compileStart } satisfies Ready);

const bridge = new MinaPortBridge(PublicKey.fromBase58(bridgeAddress));

const toRecord = (w: { nonce: string; recipient: string; amountNanomina: string }) =>
  new WithdrawalRecord({
    nonce: UInt64.from(BigInt(w.nonce)),
    recipient: PublicKey.fromBase58(w.recipient),
    amount: UInt64.from(BigInt(w.amountNanomina)),
  });

/**
 * Prove the stretch of Flare's chain that follows the released withdrawal.
 *
 * Links are proven first and merged afterwards rather than chained, so they are
 * independent — every intermediate state is known in advance, so a batch can
 * prove in parallel instead of waiting on its predecessor. Merging is folded
 * left because a release tail is short; a balanced tree would only pay off at
 * depths this will not reach.
 */
async function proveTail(from: Field, tail: ReleaseRequest['tail']) {
  if (tail.length === 0) return (await WithdrawalChain.empty(from)).proof;

  const states: Field[] = [from];
  const records = tail.map(toRecord);
  for (const record of records) {
    states.push(applyWithdrawal(states[states.length - 1]!, record));
  }

  const links = await Promise.all(
    records.map(async (record, i) => (await WithdrawalChain.link(states[i]!, record)).proof),
  );

  let segment = links[0]!;
  for (let i = 1; i < links.length; i++) {
    segment = (await WithdrawalChain.merge(segment, links[i]!)).proof;
  }
  return segment;
}

/**
 * Prove enough validator weight signed a Flare round, then publish the state.
 *
 * The signed digest is not yet bound to `actionState` — that needs the FDC
 * attestation and MerkleInclusion — so the attestor still co-signs. What the
 * proof does establish is that real policy members really signed.
 */
async function handlePublish(request: PublishRequest) {
  const attestorKey = process.env.MINA_WITHDRAWAL_ATTESTOR_PRIVATE_KEY;
  const feePayerKey = process.env.MINA_DEVNET_PRIVATE_KEY;
  if (!attestorKey || !feePayerKey) {
    throw new Error('MINA_WITHDRAWAL_ATTESTOR_PRIVATE_KEY and MINA_DEVNET_PRIVATE_KEY are required');
  }

  const attestor = PrivateKey.fromBase58(attestorKey);
  const feePayer = PrivateKey.fromBase58(feePayerKey);
  const sender = feePayer.toPublicKey();

  const calls = request.calls as RelayCall[];
  // Keys arrive resolved and address-checked; recovery and the database live on
  // the main thread, so this one only proves.
  const known = request.keys as PolicyKey[];
  const tree = buildPolicyTree(known);

  // The round with the most usable signatures, so one message carries the most
  // weight and the merge stays shallow.
  const usable = calls
    .map((call) => ({
      call,
      signatures: call.signatures
        .filter((s) => known.some((k) => k.index === s.index))
        .sort((a, b) => a.index - b.index),
    }))
    .sort((a, b) => b.signatures.length - a.signatures.length)[0];

  if (usable === undefined || usable.signatures.length === 0) {
    throw new Error('no relay signature matches a known policy key');
  }

  // Cast: the static helpers survive the build but not the emitted .d.ts.
  const digest = (Bytes32 as unknown as { fromHex(hex: string): unknown }).fromHex(
    signedMessageHash(usable.call.message).slice(2),
  );
  let merged;
  for (const signature of usable.signatures) {
    const voter = known.find((k) => k.index === signature.index)!;
    const { proof } = await SigningPolicyFold.single(digest as never, tree.root, {
      publicKey: toSecp256k1(voter.publicKey),
      signature: EcdsaSignature.from({ r: BigInt(signature.r), s: BigInt(signature.s) }),
      index: UInt32.from(voter.index),
      weight: UInt32.from(voter.weight),
      witness: tree.witnessFor(voter.index),
    } as never);
    merged = merged === undefined ? proof : (await SigningPolicyFold.merge(merged, proof)).proof;
  }

  await fetchAccount({ publicKey: sender });
  await fetchAccount({ publicKey: bridge.address });
  await fetchAccount({ publicKey: attestor.toPublicKey() });

  // Coston2 rotates its validator set every 6 hours, so a root fixed at deploy
  // goes stale the same day. Rotate before publishing rather than leaving an
  // operator to notice.
  if (bridge.signingPolicyRoot.get().toString() !== tree.root.toString()) {
    const admin = PrivateKey.fromBase58(
      process.env.MINA_ADMIN_PRIVATE_KEY ?? feePayerKey,
    );
    const rotate = await Mina.transaction(
      { sender, fee: Number(process.env.MINA_FEE ?? 100_000_000), nonce: claimNonce(sender) },
      async () => {
        await bridge.setSigningPolicyRoot(tree.root);
      },
    );
    await rotate.prove();
    const rotated = await rotate.sign([feePayer, admin]).send();
    console.log(`rotated signing policy root -> ${rotated.hash}`);
    // Waited on, unlike everything else here: the new root becomes a
    // precondition of the publication below, and o1js builds that precondition
    // from the account it has read. A rotation happens once per reward epoch,
    // so the minutes cost nothing.
    await rotated.wait();
    await fetchAccount({ publicKey: bridge.address });
  }

  const tx = await Mina.transaction(
    { sender, fee: Number(process.env.MINA_FEE ?? 100_000_000), nonce: claimNonce(sender) },
    async () => {
      await bridge.publishFlareActionState(Field(request.actionState), merged!);
    },
  );
  await tx.prove();
  const pending = await tx.sign([feePayer, attestor]).send();
  return pending.hash;
}

/**
 * Where the escrow's cursor will be once everything already sent is included.
 *
 * The same fee payer signs every release, so Mina applies them in nonce order
 * and each one's state precondition is evaluated after the previous has been
 * applied — even inside a single block. Reading the cursor from chain instead
 * would mean one release per block, each waiting minutes for the one before it,
 * because the account still shows the old value while the previous transaction
 * is in the pool.
 *
 * Cleared on any failure: from that point the on-chain value is the only one
 * that can be trusted, and a stale prediction would build proofs against a
 * cursor that never arrives.
 */
let predictedCursor: unknown | undefined;

/**
 * The fee payer's next nonce, predicted rather than read.
 *
 * `fetchAccount` returns what the chain has applied, which does not count the
 * transactions still in the pool. Two sends in a row would therefore both claim
 * the same nonce and the second would simply replace the first — silently, since
 * both `send()` calls succeed.
 *
 * Publish, rotate and release all come from this one key, so they share the
 * counter. Cleared with the cursor on any failure, since after that the chain is
 * the only trustworthy source for both.
 */
let predictedNonce: bigint | undefined;

/** Claim the next nonce, seeding from chain the first time. */
function claimNonce(sender: PublicKey): number {
  predictedNonce ??= Mina.getAccount(sender).nonce.toBigint();
  const n = predictedNonce;
  predictedNonce = n + 1n;
  return Number(n);
}

/** Everything predicted is only sound while every send has succeeded. */
function forgetPredictions(): void {
  predictedCursor = undefined;
  predictedNonce = undefined;
}

async function handleRelease(request: ReleaseRequest) {
  const feePayerKey = process.env.MINA_DEVNET_PRIVATE_KEY;
  if (!feePayerKey) throw new Error('MINA_DEVNET_PRIVATE_KEY is required');

  const feePayer = PrivateKey.fromBase58(feePayerKey);
  const sender = feePayer.toPublicKey();

  await fetchAccount({ publicKey: sender });
  await fetchAccount({ publicKey: bridge.address });

  const record = toRecord(request);

  const processed = (predictedCursor as Field | undefined) ?? bridge.processedActionState.get();
  const next = applyWithdrawal(processed, record);
  const tail = await proveTail(next, request.tail);

  // The balance precondition is a range, `amount .. MAXINT`, not an equality —
  // which is what lets several releases queue behind one another without the
  // second's proof being invalidated by the first's payout.
  const tx = await Mina.transaction(
    { sender, fee: Number(process.env.MINA_FEE ?? 100_000_000), nonce: claimNonce(sender) },
    async () => {
      await bridge.releaseWithdrawal(record, tail);
    },
  );
  await tx.prove();

  // Only the fee payer signs now. Authorisation is the tail proof, so a relayer
  // holding this key still cannot release anything Flare did not commit to.
  const pending = await tx.sign([feePayer]).send();
  predictedCursor = next;
  return pending.hash;
}

port.on('message', async (request: Request) => {
  if (request.kind === 'publish') {
    try {
      port.postMessage({ type: 'released', id: request.id, hash: await handlePublish(request) });
    } catch (error) {
      forgetPredictions();
      port.postMessage({
        type: 'failed',
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (request.kind === 'release') {
    try {
      port.postMessage({ type: 'released', id: request.id, hash: await handleRelease(request) });
    } catch (error) {
      forgetPredictions();
      port.postMessage({
        type: 'failed',
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  try {
    const sender = PublicKey.fromBase58(request.sender);

    // The sender's on-chain account is needed to build a valid transaction
    // (fee-payer nonce, balance). Fetching it here rather than trusting the
    // caller means a wrong address fails now, not at broadcast time.
    let t = Date.now();
    await fetchAccount({ publicKey: sender });
    console.log(`  fetch sender: ${Date.now() - t}ms`);
    t = Date.now();
    await fetchAccount({ publicKey: bridge.address });
    console.log(`  fetch bridge: ${Date.now() - t}ms`);

    const started = Date.now();
    const tx = await Mina.transaction({ sender, fee: Number(process.env.MINA_FEE ?? 100_000_000) }, async () => {
      await bridge.deposit(
        UInt64.from(BigInt(request.nonce)),
        flareRecipientField(request.recipient),
        UInt64.from(BigInt(request.amountNanomina)),
      );
    });
    console.log(`  build: ${Date.now() - started}ms`);
    t = Date.now();
    await tx.prove();
    console.log(`  prove: ${Date.now() - t}ms`);

    port.postMessage({
      type: 'built',
      id: request.id,
      // Serialised, unsigned. The wallet signs and broadcasts it.
      transaction: tx.toJSON(),
      provingMs: Date.now() - started,
    } satisfies Built);
  } catch (error) {
    port.postMessage({
      type: 'failed',
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies Failed);
  }
});
