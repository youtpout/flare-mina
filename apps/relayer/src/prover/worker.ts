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
  addCachedAccount,
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

// Not `Cache.FileSystem`: it cannot write FdcLeaf's 2.6 GB step key, and fails
// silently when it tries. See ./cache.ts.
const { chunkedCache } = await import('./cache.js');
const cacheOptions = CACHE_DIR ? { cache: chunkedCache(CACHE_DIR) } : {};

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
 * `range` is everything Flare committed to between the escrow's cursor and the
 * head it has accepted — every asset, in order. Which record gets paid is
 * decided inside the circuit, so nothing here names a recipient or an amount.
 * The relayer therefore cannot invent, redirect or resize a withdrawal, nor
 * choose to skip one: a range in the wrong order, or missing a link, reaches a
 * different head and is refused.
 */
type ReleaseRequest = {
  kind: 'release';
  id: number;
  range: ChainLink[];
  /** Part of a wave: send without waiting, the caller confirms the whole run. */
  wave?: boolean;
  /**
   * First of a wave: drop every prediction and re-read the chain.
   *
   * A transaction that `send()` accepted can still be rejected by consensus,
   * and that failure never reaches this process — so the cursor predicted from
   * it would be wrong with nothing to signal it. Re-anchoring once per wave
   * bounds how long a bad prediction can survive to a single wave.
   */
  restart?: boolean;
};

/** One link of the shared chain, as it crosses the process boundary. */
type ChainLink = { index: string; token: string; recipient: string; amount: string };

/**
 * Push Flare's withdrawal chain state to the escrow.
 *
 * `calls` are recent `Relay.relay()` transactions: the signing policy and the
 * validator signatures both come out of their calldata, and nowhere else.
 */
type PublishRequest = {
  kind: 'publish';
  id: number;
  /** ABI-encoded FDC response, hex without 0x. */
  response: string;
  /** Sibling hashes bottom to top, hex without 0x. */
  siblings: string[];
  calls: unknown[];
  keys: unknown[];
};

/**
 * Push one token's Flare lock-chain head to its Mina port.
 *
 * Same shape as {PublishRequest} and the same proof, against a different
 * contract: a port holds one asset, so each has its own chain and its own head.
 */
type PublishLockRequest = {
  kind: 'publishLock';
  id: number;
  /** The port's zkApp address. */
  port: string;
  response: string;
  siblings: string[];
  calls: unknown[];
  keys: unknown[];
};

/**
 * Mint a locked asset on Mina: authorise the claim, then mint it.
 *
 * Two transactions, and they cannot be combined — a second account update on
 * the same zkApp does not observe state an earlier one wrote in the same
 * transaction, so `canMint` would read an empty authorisation and refuse. See
 * the note on `AssetPort`.
 *
 * `range` spans the port's cursor to its accepted head, exactly as a release
 * does, and `asset` is what tells this port's locks from the ones it steps
 * over. No fabricated record fits in a range reaching that head, which is what
 * stops the relayer inventing, redirecting or resizing a mint.
 */
type MintRequest = {
  kind: 'mint';
  id: number;
  port: string;
  token: string;
  /** Flare address of the asset this port administers. */
  asset: string;
  range: ChainLink[];
  /** Part of a wave: send without waiting, the caller confirms the whole run. */
  wave?: boolean;
  /** First of a wave: drop every prediction and re-read the chain. */
  restart?: boolean;
};

/**
 * Build an unsigned burn of a wrapped asset, for the holder to sign.
 *
 * The return leg's first step. Built here rather than in the page for the same
 * reason a deposit is: burning through a token contract needs a proof, and
 * shipping the prover to the browser is megabytes of wasm for a transaction the
 * relayer can already produce — it compiles `FungibleToken` to mint.
 *
 * Nothing about it is trusted. The holder signs the account update that debits
 * them, and the Flare side releases only against their own Schnorr signature
 * over the token, recipient and amount.
 */
type BurnRequest = {
  kind: 'burn';
  id: number;
  /** Holder, who signs and pays the fee. */
  sender: string;
  /** The `FungibleToken` zkApp. */
  token: string;
  amount: string;
};

type Request =
  | BuildRequest
  | BurnRequest
  | ReleaseRequest
  | PublishRequest
  | PublishLockRequest
  | MintRequest;

type Ready = { type: 'ready'; compileMs: number };
type Built = { type: 'built'; id: number; transaction: string; provingMs: number };
type Failed = { type: 'failed'; id: number; error: string };

/**
 * A forked child process, not a worker thread.
 *
 * Threads would share the process heap and, more to the point, one instance of
 * the `@o1js/native` NAPI addon — which nothing promises is safe to load twice
 * in a process. A fork gives each prover its own o1js global context and its
 * own addon, which is what lets a user's deposit prove while a publication is
 * mid-flight.
 */
if (process.send === undefined) {
  throw new Error('prover worker must be started with child_process.fork');
}
const port = {
  postMessage: (message: unknown) => void process.send!(message),
  on(_event: 'message', handler: (request: Request) => void) {
    process.on('message', (m) => handler(m as Request));
  },
};

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
const { attestationLeaf } = await import('@minaport/shared/dist/src/fdcResponse.js');
/** The leaf, as hex without 0x — the form o1js `Bytes.fromHex` wants. */
const keccak = (hex: string) => attestationLeaf(`0x${hex}` as `0x${string}`).slice(2);
const { TransferChain, TransferRecord, applyTransfer } = await import(
  '@minaport/mina-contracts/dist/src/TransferChain.js'
);
const { SigningPolicyFold, EcdsaSignature, Bytes32 } = await import(
  '@minaport/mina-contracts/dist/src/SigningPolicyFold.js'
);
const { buildPolicyTree, toSecp256k1 } = await import(
  '@minaport/mina-contracts/dist/src/policyTree.js'
);
const { MinaPortBridge, flareRecipientField } = await import(
  '@minaport/mina-contracts/dist/src/MinaPortBridge.js'
);
const { RelayMessage, Bytes38, FDC_PROTOCOL_ID } = await import(
  '@minaport/mina-contracts/dist/src/RelayMessage.js'
);
const { AssetPort, mintCommitment, NO_MINT_AUTHORIZED } = await import(
  '@minaport/mina-contracts/dist/src/AssetPort.js'
);
const { AttestationResponse, FdcAttestation, FdcLeaf } = await import(
  '@minaport/mina-contracts/dist/src/FdcAttestation.js'
);
const { MerkleInclusion } = await import('@minaport/mina-contracts/dist/src/MerkleInclusion.js');
const { FungibleToken } = await import('mina-fungible-token');

// The token resolves its admin through this, and every wrapped asset in this
// deployment is administered by an `AssetPort`.
FungibleToken.AdminContract = AssetPort as never;

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
await TransferChain.compile(cacheOptions);
await RelayMessage.compile(cacheOptions);
await MerkleInclusion.compile(cacheOptions);
await SigningPolicyFold.compile(cacheOptions);
// FdcLeaf before the contracts: they verify proofs that chain up to it.
await FdcLeaf.compile(cacheOptions);
await FdcAttestation.compile(cacheOptions);
await MinaPortBridge.compile(cacheOptions);
// The asset rail. Skipped entirely when no port is configured, because these
// two add ~30s to a cold start and a MINA-only deployment never uses them.
// The chain program is shared with the escrow, so it is already compiled.
if (process.env.MINA_ASSET_PORTS) {
  await AssetPort.compile(cacheOptions);
  await FungibleToken.compile(cacheOptions);
}
port.postMessage({ type: 'ready', compileMs: Date.now() - compileStart } satisfies Ready);

const bridge = new MinaPortBridge(PublicKey.fromBase58(bridgeAddress));

const toRecord = (r: ChainLink) =>
  new TransferRecord({
    index: UInt64.from(BigInt(r.index)),
    token: Field(BigInt(r.token)),
    recipient: PublicKey.fromBase58(r.recipient),
    amount: UInt64.from(BigInt(r.amount)),
  });

/**
 * Prove a stretch of the shared chain, examined for one asset.
 *
 * The output names the first record of `token` in it and the head just after —
 * which is what a consumer pays and where its cursor lands. Records of other
 * assets are included and stepped over; leaving them out would produce a
 * segment that does not meet.
 *
 * Links are proven first and merged afterwards rather than chained: every
 * intermediate state is known in advance, so no link waits on its predecessor's
 * proof. They are still proven one at a time — o1js has a single global proving
 * context, and `Promise.all` over two links corrupts it, reporting a missing
 * `await` rather than the real cause.
 */
async function proveSegment(from: Field, token: Field, range: ChainLink[]) {
  let segment = (await TransferChain.empty(from, token)).proof;
  if (range.length === 0) return segment;

  const states: Field[] = [from];
  const records = range.map(toRecord);
  for (const record of records) {
    states.push(applyTransfer(states[states.length - 1]!, record));
  }

  const links = [];
  for (let i = 0; i < records.length; i++) {
    links.push((await TransferChain.link(states[i]!, token, records[i]!)).proof);
  }

  for (const link of links) {
    segment = (await TransferChain.merge(segment, link)).proof;
  }
  return segment;
}

/** The record a consumer will be paid for: the first of its asset in the range. */
function firstOf(token: string, range: ChainLink[]): ChainLink | undefined {
  return range.find((r) => BigInt(r.token) === BigInt(token));
}

/**
 * Prove that enough validator weight signed a Flare round.
 *
 * Shared by both rails: the MINA escrow and every asset port accept the same
 * proof, because "this is the live validator set and it signed" is one question
 * regardless of which chain state is being carried.
 */
async function proveSigningPolicy(rawCalls: unknown[], rawKeys: unknown[]) {
  const calls = rawCalls as RelayCall[];
  // Keys arrive resolved and address-checked; recovery and the database live on
  // the main thread, so this one only proves.
  const known = rawKeys as PolicyKey[];
  const tree = buildPolicyTree(known);

  // FDC rounds only. The contracts require protocol 200 — those are the ones
  // carrying attestation roots — and Coston2 relays FTSO rounds just as often,
  // so picking purely by signature count lands on a round the chain will refuse.
  const usable = calls
    .filter((call) => call.message.protocolId === FDC_PROTOCOL_ID)
    .map((call) => ({
      call,
      signatures: call.signatures
        .filter((s) => known.some((k) => k.index === s.index))
        .sort((a, b) => a.index - b.index),
    }))
    .sort((a, b) => b.signatures.length - a.signatures.length)[0];

  if (usable === undefined || usable.signatures.length === 0) {
    throw new Error('no FDC round in the window carries a signature from a known policy key');
  }

  // The round the validators signed, proven rather than asserted. The fold
  // verifies this and derives the digest from it, so a signature can no longer
  // be pointed at a round — or a state — it never covered.
  // Cast: the static helpers survive the build but not the emitted .d.ts.
  const { proof: relay } = await RelayMessage.bind(
    (Bytes38 as unknown as { fromHex(hex: string): unknown }).fromHex(
      usable.call.message.encoded.slice(2),
    ) as never,
  );

  const digest = (Bytes32 as unknown as { fromHex(hex: string): unknown }).fromHex(
    signedMessageHash(usable.call.message).slice(2),
  );
  let merged;
  for (const signature of usable.signatures) {
    const voter = known.find((k) => k.index === signature.index)!;
    const { proof } = await SigningPolicyFold.single(relay as never, tree.root, {
      publicKey: toSecp256k1(voter.publicKey),
      signature: EcdsaSignature.from({ r: BigInt(signature.r), s: BigInt(signature.s) }),
      index: UInt32.from(voter.index),
      weight: UInt32.from(voter.weight),
      witness: tree.witnessFor(voter.index),
    } as never);
    merged = merged === undefined ? proof : (await SigningPolicyFold.merge(merged, proof)).proof;
  }

  return { merged: merged!, tree };
}

/**
 * Turn an FDC response and its Merkle path into the single proof a contract
 * takes: the response hashed, the path climbed, the round's signatures folded.
 *
 * Levels prove independently and are merged left, because a path is three or
 * four deep at most — a balanced tree would only pay off well past that.
 */
/**
 * The last attestation proved, and what it was proved from.
 *
 * One publication cycle pushes the same head into the escrow and every asset
 * port, one after another. Each of those used to rebuild the whole chain —
 * signing policy, inclusion, `FdcLeaf` — so the 43-second keccak was paid four
 * times for one round. The shared chain saved four FDC *attestations*; this is
 * what saves the four proving passes that went with them.
 *
 * A single entry, not a map: the reuse is a burst within one tick, and a map
 * would hold a multi-hundred-megabyte proof alive for no one.
 *
 * Keyed on the response and its path. The policy proof also depends on `calls`
 * and `keys`, but those come from the round that response sits in — the same
 * response under a different validator set is not a thing a round can produce.
 */
let lastAttestation:
  | { key: string; value: Awaited<ReturnType<typeof buildAttestation>>; ms: number }
  | undefined;

async function proveAttestation(
  responseHex: string,
  siblings: string[],
  calls: unknown[],
  keys: unknown[],
) {
  const key = `${responseHex}|${siblings.join(',')}`;
  if (lastAttestation?.key === key) {
    console.log(
      `  reused the attestation proof (built in ${(lastAttestation.ms / 1000).toFixed(1)}s, ` +
        'not paid again)',
    );
    return lastAttestation.value;
  }

  const started = Date.now();
  const value = await buildAttestation(responseHex, siblings, calls, keys);
  const ms = Date.now() - started;
  console.log(`  built the attestation proof in ${(ms / 1000).toFixed(1)}s`);
  lastAttestation = { key, value, ms };
  return value;
}

async function buildAttestation(
  responseHex: string,
  siblings: string[],
  calls: unknown[],
  keys: unknown[],
) {
  // Timed per stage: "the proof took two minutes" is not actionable, and the
  // stages have very different costs — one ECDSA against a keccak over 1344
  // bytes — so which one to attack is the only useful thing to know.
  const stage = (label: string, from: number) =>
    console.log(`    ${label.padEnd(18)} ${((Date.now() - from) / 1000).toFixed(1)}s`);

  let t = Date.now();
  const { merged: policy, tree } = await proveSigningPolicy(calls, keys);
  stage('signing policy', t);

  const bytes32 = (hex: string) =>
    (Bytes32 as unknown as { fromHex(h: string): unknown }).fromHex(hex);
  const response = (
    AttestationResponse as unknown as { fromHex(h: string): unknown }
  ).fromHex(responseHex);

  // Climb from the leaf, one level at a time.
  t = Date.now();
  const leafDigest = keccak(responseHex);
  let segment = (await MerkleInclusion.level(
    bytes32(leafDigest) as never,
    bytes32(siblings[0]!) as never,
  )).proof;
  for (const sibling of siblings.slice(1)) {
    const next = (await MerkleInclusion.level(
      segment.publicOutput.top,
      bytes32(sibling) as never,
    )).proof;
    segment = (await MerkleInclusion.merge(segment, next)).proof;
  }

  stage('merkle inclusion', t);

  t = Date.now();
  const { proof: leaf } = await FdcLeaf.read(response as never, segment);
  stage('fdc leaf', t);

  t = Date.now();
  const { proof: attestation } = await FdcAttestation.attest(leaf, policy);
  stage('fdc attestation', t);

  return { attestation, tree };
}

/**
 * Wait for a transaction, treating a timeout as unknown rather than failed.
 *
 * `wait()` gives up after a fixed number of polls and throws — but devnet is
 * simply slow, and the transaction usually lands moments later. Letting that
 * throw aborted a whole publication cycle over a rotation that had in fact
 * succeeded, and the next cycle would rotate again.
 *
 * The caller re-reads the account afterwards, which is the only honest way to
 * know: this is the third thing today whose apparent success or failure said
 * nothing about what the chain did.
 */
async function settle(pending: { hash: string; wait(): Promise<unknown> }, label: string) {
  try {
    await pending.wait();
  } catch {
    console.warn(`${label} ${pending.hash} not confirmed in time; checking the account`);
  }
}

/**
 * Publish a chain state read out of an attested Flare event.
 *
 * Nothing is co-signed. The proof carries the validator signatures, the round
 * they signed, the response under that round's root, and the state inside the
 * event — so the escrow can check every step itself.
 */
async function handlePublish(request: PublishRequest) {
  const feePayerKey = process.env.MINA_DEVNET_PRIVATE_KEY;
  if (!feePayerKey) throw new Error('MINA_DEVNET_PRIVATE_KEY is required');

  const feePayer = PrivateKey.fromBase58(feePayerKey);
  const sender = feePayer.toPublicKey();

  const { attestation, tree } = await proveAttestation(
    request.response,
    request.siblings,
    request.calls,
    request.keys,
  );

  await fetchAccount({ publicKey: sender });
  await fetchAccount({ publicKey: bridge.address });

  // Coston2 rotates its validator set every 6 hours, so a root fixed at deploy
  // goes stale the same day. Rotate before publishing rather than leaving an
  // operator to notice.
  // Set when this run rotated the root itself, so the publication below knows
  // the escrow is one transaction ahead of what the chain reports.
  let rotatedHere: { from: Field; to: Field } | undefined;
  const onChainRoot = bridge.signingPolicyRoot.get();

  if (onChainRoot.toString() !== tree.root.toString()) {
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
    rotatedHere = { from: onChainRoot, to: tree.root };
  }

  const tx = await Mina.transaction(
    { sender, fee: Number(process.env.MINA_FEE ?? 100_000_000), nonce: claimNonce(sender) },
    async () => {
      // The new root is a precondition of this publication, so it used to wait
      // for the rotation to be included. Built against the root the rotation
      // leaves, the pair rides one block.
      if (rotatedHere !== undefined) {
        predictState(bridge.address, POLICY_ROOT_SLOT, rotatedHere.from, rotatedHere.to);
      }
      await bridge.publishFlareActionState(attestation);
    },
  );
  await tx.prove();
  // Only the fee payer signs. The state came out of a proof.
  const pending = await tx.sign([feePayer]).send();
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

/**
 * Highest nonce this process has ever handed out.
 *
 * Deliberately never cleared, unlike `predictedNonce`. Reseeding from chain
 * after a failure looked safe and was not: the chain does not count what is
 * still in the pool, so the reseed handed out a nonce a pending transaction had
 * already claimed and Mina rejected the pair with `Insufficient_replace_fee`.
 * A high-water mark cannot go backwards, so a reseed can only ever skip
 * forward — and a skipped nonce costs one stalled transaction, where a reused
 * one costs a lost transaction the caller believes was sent.
 */
let issuedNonce: bigint | undefined;

/** Claim the next nonce, seeding from chain but never below what was issued. */
function claimNonce(sender: PublicKey): number {
  const onChain = Mina.getAccount(sender).nonce.toBigint();
  const floor = issuedNonce === undefined ? onChain : issuedNonce + 1n;
  const n = predictedNonce ?? (onChain > floor ? onChain : floor);

  predictedNonce = n + 1n;
  issuedNonce = n;
  return Number(n);
}

/** Everything predicted is only sound while every send has succeeded. */
function forgetPredictions(): void {
  predictedCursor = undefined;
  predictedNonce = undefined;
  predictedLockCursor.clear();
}

/**
 * Position of `processedActionState` in the escrow's `appState`.
 *
 * From the declaration order in `MinaPortBridge`: root, chain, flare, processed.
 * `predictState` asserts the slot still holds the cursor before touching it, so
 * a reordering fails loudly here instead of proving against another field.
 */
const PROCESSED_SLOT = 3;

/** First slot of both contracts, and the same field in each. */
const POLICY_ROOT_SLOT = 0;

/**
 * Slots of `AssetPort`, from its declaration order: root, flare, processed,
 * weight, asset, authorization, chain, admin.
 */
const PROCESSED_LOCK_SLOT = 2;
const MINT_AUTH_SLOT = 5;

/**
 * Build against a state the chain has not applied yet.
 *
 * This has to run *inside* the transaction callback. `Mina.transaction` runs the
 * callback twice, with `Fetch.fetchMissingData()` between the passes, and that
 * refetch overwrites the account cache with what the node still reports — the
 * state from before the transactions already sitting in the pool. Anything
 * injected before the build is wiped; injected here it lands after the refetch,
 * so the proof is built against the state its predecessor leaves behind.
 *
 * The whole account is rewritten, never a partial one: `fillPartialAccount`
 * replaces every field left out with `type.empty()`, so an omitted `tokenId`
 * becomes Field(0) and the entry goes under a cache key nothing reads.
 */
function predictState(address: PublicKey, slot: number, expected: Field, value: Field): void {
  const account = Mina.getAccount(address);
  if (account.zkapp === undefined) throw new Error('predictState: not a zkApp account');

  const appState = [...account.zkapp.appState];
  const held = appState[slot]!;
  // Only the chain's own value may be replaced. On the second pass the slot
  // already holds what we wrote, which is why this accepts either.
  if (held.toString() !== expected.toString() && held.toString() !== value.toString()) {
    throw new Error(`predictState: slot ${slot} holds ${held}, not the cursor`);
  }

  appState[slot] = value;
  addCachedAccount({ ...account, zkapp: { ...account.zkapp, appState } }, graphql);
}

async function handleRelease(request: ReleaseRequest) {
  const feePayerKey = process.env.MINA_DEVNET_PRIVATE_KEY;
  if (!feePayerKey) throw new Error('MINA_DEVNET_PRIVATE_KEY is required');

  const feePayer = PrivateKey.fromBase58(feePayerKey);
  const sender = feePayer.toPublicKey();

  // Only this rail's cursor. `forgetPredictions()` would clear every port's too,
  // and ports now run their waves concurrently — one rail re-anchoring must not
  // invalidate another's in-flight prediction.
  if (request.restart === true) predictedCursor = undefined;

  await fetchAccount({ publicKey: sender });
  await fetchAccount({ publicKey: bridge.address });

  const fmina = process.env.FLARE_FMINA_ADDRESS;
  if (!fmina) throw new Error('FLARE_FMINA_ADDRESS is required');
  if (firstOf(fmina, request.range) === undefined) {
    throw new Error('the range holds no MINA withdrawal to release');
  }

  const onChain = bridge.processedActionState.get();
  const processed = (predictedCursor as Field | undefined) ?? onChain;
  const segment = await proveSegment(processed, Field(BigInt(fmina)), request.range);
  // Where the cursor lands: just past the withdrawal the circuit picked, having
  // stepped over any other asset's transfers before it.
  const next = segment.publicOutput.stateAfterFirst;

  // The balance precondition is a range, `amount .. MAXINT`, not an equality —
  // which is what lets several releases queue behind one another without the
  // second's proof being invalidated by the first's payout.
  const tx = await Mina.transaction(
    { sender, fee: Number(process.env.MINA_FEE ?? 100_000_000), nonce: claimNonce(sender) },
    async () => {
      // The escrow reads its cursor as a precondition. Without this the circuit
      // would read the chain's value and every release after the first in a wave
      // would prove against a cursor its predecessor has already moved.
      predictState(bridge.address, PROCESSED_SLOT, onChain, processed);
      await bridge.releaseWithdrawal(segment);
    },
  );
  await tx.prove();

  // Only the fee payer signs now. Authorisation is the segment proof, so a
  // relayer holding this key still cannot release anything Flare did not
  // commit to.
  const pending = await tx.sign([feePayer]).send();
  predictedCursor = next;

  // A release in a wave is not confirmed here. Waiting for inclusion between
  // sends is precisely what the prediction removes, and confirming still
  // happens — once for the whole wave, by the caller, against the cursor.
  if (request.wave === true) return pending.hash;

  // Confirmed against the cursor, not against the hash. `send()` resolves for a
  // transaction that is then rejected, and the caller marks this withdrawal
  // released and stops retrying — the user's MINA never arrives and nothing
  // ever notices. The cursor is the only thing that says the payment happened.
  await settle(pending, 'release');
  await fetchAccount({ publicKey: bridge.address });
  if (bridge.processedActionState.get().toString() !== next.toString()) {
    throw new Error(`release ${pending.hash} did not advance the cursor`);
  }
  return pending.hash;
}

/** Carry one token's Flare lock head to its port, rotating the policy if stale. */
async function handlePublishLock(request: PublishLockRequest) {
  const feePayerKey = process.env.MINA_DEVNET_PRIVATE_KEY;
  if (!feePayerKey) throw new Error('MINA_DEVNET_PRIVATE_KEY is required');

  const feePayer = PrivateKey.fromBase58(feePayerKey);
  const sender = feePayer.toPublicKey();
  // The port's admin signs only a policy-root rotation, which Flare forces
  // every reward epoch. It asserts nothing about the state being published.
  const admin = PrivateKey.fromBase58(
    process.env.MINA_LOCK_ADMIN_PRIVATE_KEY ??
      process.env.MINA_WITHDRAWAL_ATTESTOR_PRIVATE_KEY ??
      feePayerKey,
  );

  const { attestation, tree } = await proveAttestation(
    request.response,
    request.siblings,
    request.calls,
    request.keys,
  );
  const assetPort = new AssetPort(PublicKey.fromBase58(request.port));

  await fetchAccount({ publicKey: sender });
  await fetchAccount({ publicKey: assetPort.address });
  await fetchAccount({ publicKey: admin.toPublicKey() });

  // Set when this run rotated the root itself, so the publication below knows
  // the port is one transaction ahead of what the chain reports.
  let rotatedHere: { from: Field; to: Field } | undefined;
  const onChainRoot = assetPort.signingPolicyRoot.get();

  if (onChainRoot.toString() !== tree.root.toString()) {
    const rotate = await Mina.transaction(
      { sender, fee: Number(process.env.MINA_FEE ?? 100_000_000), nonce: claimNonce(sender) },
      async () => {
        // The admin key is an argument now: the port stores its hash rather
        // than the key, so the eighth state field can hold the asset.
        await assetPort.setSigningPolicyRoot(tree.root, admin.toPublicKey());
      },
    );
    await rotate.prove();
    const rotated = await rotate.sign([feePayer, admin]).send();
    console.log(`rotated ${request.port} policy root -> ${rotated.hash}`);
    rotatedHere = { from: onChainRoot, to: tree.root };
  }

  const tx = await Mina.transaction(
    { sender, fee: Number(process.env.MINA_FEE ?? 100_000_000), nonce: claimNonce(sender) },
    async () => {
      // The new root is a precondition of this publication, so it used to wait
      // for the rotation to be included — a block per port, four times a day
      // when Flare rotates its validator set. Built against the root the
      // rotation leaves, the pair rides one block.
      if (rotatedHere !== undefined) {
        predictState(assetPort.address, POLICY_ROOT_SLOT, rotatedHere.from, rotatedHere.to);
      }
      await assetPort.publishFlareLockState(attestation);
    },
  );
  await tx.prove();
  // Only the fee payer signs. The state came out of a proof.
  const pending = await tx.sign([feePayer]).send();
  return pending.hash;
}

/**
 * Where each port's cursor will be once everything already sent is included.
 *
 * Per port, unlike the escrow's single cursor: chains are per token, so two
 * ports advance independently and one prediction would be wrong for the other.
 */
const predictedLockCursor = new Map<string, unknown>();

async function handleMint(request: MintRequest) {
  const feePayerKey = process.env.MINA_DEVNET_PRIVATE_KEY;
  if (!feePayerKey) throw new Error('MINA_DEVNET_PRIVATE_KEY is required');

  const feePayer = PrivateKey.fromBase58(feePayerKey);
  const sender = feePayer.toPublicKey();

  // This port only, for the same reason: waves run concurrently across ports.
  if (request.restart === true) predictedLockCursor.delete(request.port);

  const assetPort = new AssetPort(PublicKey.fromBase58(request.port));
  const token = new FungibleToken(PublicKey.fromBase58(request.token));

  // The lock the circuit will pick, computed here too so the armed check below
  // can run before paying for a proof. The circuit is what enforces it.
  const claimed = firstOf(request.asset, request.range);
  if (claimed === undefined) throw new Error('the range holds no lock of this asset');
  const recipient = PublicKey.fromBase58(claimed.recipient);
  const amount = UInt64.from(BigInt(claimed.amount));

  await fetchAccount({ publicKey: sender });
  await fetchAccount({ publicKey: assetPort.address });
  await fetchAccount({ publicKey: token.address });

  // Resume rather than restart. `authorizeMint` and the mint are two
  // transactions, so a failure between them leaves the claim armed and its
  // cursor already advanced — re-authorising would then fail forever on a
  // record the chain has moved past, stranding the user's tokens in the vault.
  const alreadyArmed = assetPort.mintAuthorization
    .get()
    .equals(mintCommitment(recipient, amount))
    .toBoolean();

  // Set when this run armed the claim itself, so the mint below knows the port's
  // state is one transaction ahead of what the chain reports.
  let armedHere: { cursorFrom: Field; cursorTo: Field } | undefined;

  if (!alreadyArmed) {
    const onChainCursor = assetPort.processedLockState.get();
    const processed = (predictedLockCursor.get(request.port) as Field | undefined) ?? onChainCursor;
    const segment = await proveSegment(processed, Field(BigInt(request.asset)), request.range);
    const next = segment.publicOutput.stateAfterFirst;

    const authorize = await Mina.transaction(
      { sender, fee: Number(process.env.MINA_FEE ?? 100_000_000), nonce: claimNonce(sender) },
      async () => {
        predictState(assetPort.address, PROCESSED_LOCK_SLOT, onChainCursor, processed);
        await assetPort.authorizeMint(segment);
      },
    );
    await authorize.prove();
    const armed = await authorize.sign([feePayer]).send();
    predictedLockCursor.set(request.port, next);
    armedHere = { cursorFrom: onChainCursor, cursorTo: next };
    console.log(`armed the claim -> ${armed.hash}`);
  }

  // The recipient's token account may not exist. Funding one that already
  // exists is refused, so ask the chain rather than guessing.
  const existing = await fetchAccount({ publicKey: recipient, tokenId: token.deriveTokenId() });
  const isNew = existing.account === undefined;

  const mint = await Mina.transaction(
    { sender, fee: Number(process.env.MINA_FEE ?? 100_000_000), nonce: claimNonce(sender) },
    async () => {
      // `canMint` reads `mintAuthorization` as a precondition, so this used to
      // wait for the authorisation to be included — a whole block per mint, on
      // top of the one the mint itself costs. Built against the state the
      // authorisation leaves, the pair rides one block.
      if (armedHere !== undefined) {
        predictState(assetPort.address, PROCESSED_LOCK_SLOT, armedHere.cursorFrom, armedHere.cursorTo);
        predictState(
          assetPort.address,
          MINT_AUTH_SLOT,
          NO_MINT_AUTHORIZED,
          mintCommitment(recipient, amount),
        );
      }
      if (isNew) AccountUpdate.fundNewAccount(sender, 1);
      await token.mint(recipient, amount);
    },
  );
  await mint.prove();
  const minted = await mint.sign([feePayer]).send();

  // In a wave nothing is confirmed here: the caller settles the whole run
  // against the port's cursor, which is what says a claim was paid.
  if (request.wave === true) return minted.hash;

  // Same reasoning as the release: a mint whose transaction is rejected still
  // resolves here, and the caller would record the asset as delivered. What
  // proves it ran is `canMint` clearing the authorisation it was armed with.
  await settle(minted, 'mint');
  await fetchAccount({ publicKey: assetPort.address });
  if (!assetPort.mintAuthorization.get().equals(NO_MINT_AUTHORIZED).toBoolean()) {
    throw new Error(`mint ${minted.hash} did not consume the authorisation`);
  }
  return minted.hash;
}

/**
 * Fetch a user's account, or say plainly that it does not exist yet.
 *
 * o1js reports this as `getAccount: Could not find account for public key …`
 * with the GraphQL endpoint appended, which reads like a broken relayer rather
 * than an empty wallet. On Mina an account exists only once it has been funded,
 * so this is what every first-time user hits — and the fix is a faucet, not a
 * bug report.
 */
async function requireUserAccount(sender: PublicKey): Promise<void> {
  const { account } = await fetchAccount({ publicKey: sender });
  if (account === undefined) {
    throw new Error(
      `This Mina account does not exist yet (${sender.toBase58()}). ` +
        'Fund it from the devnet faucet, or send it MINA from another account, then try again.',
    );
  }
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
  if (request.kind === 'publishLock') {
    try {
      port.postMessage({
        type: 'released',
        id: request.id,
        hash: await handlePublishLock(request),
      });
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
  if (request.kind === 'mint') {
    try {
      port.postMessage({ type: 'released', id: request.id, hash: await handleMint(request) });
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
  if (request.kind === 'burn') {
    try {
      const started = Date.now();
      const sender = PublicKey.fromBase58(request.sender);
      const token = new FungibleToken(PublicKey.fromBase58(request.token));

      await requireUserAccount(sender);
      await fetchAccount({ publicKey: token.address });
      // The holder's token account, which is what the burn debits. Without it
      // the transaction is built against a balance o1js has not seen.
      await fetchAccount({ publicKey: sender, tokenId: token.deriveTokenId() });

      const tx = await Mina.transaction(
        { sender, fee: Number(process.env.MINA_FEE ?? 100_000_000) },
        async () => {
          await token.burn(sender, UInt64.from(BigInt(request.amount)));
        },
      );
      await tx.prove();

      port.postMessage({
        type: 'built',
        id: request.id,
        transaction: tx.toJSON(),
        provingMs: Date.now() - started,
      } satisfies Built);
    } catch (error) {
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
    await requireUserAccount(sender);
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
