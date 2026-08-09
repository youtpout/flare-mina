import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, type ChildProcess } from 'node:child_process';

/**
 * Front end to the proving worker: one worker, one proof at a time, a queue in
 * front.
 *
 * The serialisation is deliberate. Proving saturates the cores it is given, so
 * two concurrent proofs do not finish in the time of one — they finish in twice
 * the time, together. A queue turns that into predictable latency and lets the
 * API answer honestly about the wait.
 */

export type DepositRequest = {
  /** Depositor's Mina address, base58. */
  sender: string;
  /** Flare address the FMINA will be minted to. */
  recipient: `0x${string}`;
  amountNanomina: bigint;
  /** Caller-chosen; makes the deposit unique. See `MinaPortBridge.deposit`. */
  nonce: bigint;
};

export type BuiltDeposit = {
  /** Serialised, unsigned zkApp transaction. The wallet signs and sends it. */
  transaction: string;
  provingMs: number;
};

type Pending = {
  resolve: (built: BuiltDeposit) => void;
  reject: (error: Error) => void;
};

/**
 * Two provers, because they serve different masters.
 *
 * A publication is three to five minutes of proving; a deposit is a couple of
 * seconds with a user watching. One queue meant a deposit arriving mid-cycle
 * waited behind the whole publication — a one-in-four chance of a four-minute
 * spinner, which is exactly the kind of thing that ruins a live demo.
 *
 * Forked processes rather than worker threads: threads share the process heap
 * and one instance of the `@o1js/native` addon, and o1js proves inside a global
 * context that cannot be entered twice. Separate processes have neither
 * problem. The cost is real — each compiles the whole stack and holds it, so
 * memory roughly doubles.
 */
type Lane = 'user' | 'background';

type Prover = {
  child?: ChildProcess;
  ready?: Promise<void>;
  queue: Promise<unknown>;
  pending: Map<number, Pending>;
};

const provers: Record<Lane, Prover> = {
  user: { queue: Promise.resolve(), pending: new Map() },
  background: { queue: Promise.resolve(), pending: new Map() },
};

let nextId = 1;

function start(lane: Lane): Promise<void> {
  const prover = provers[lane];
  if (prover.ready !== undefined) return prover.ready;

  const here = dirname(fileURLToPath(import.meta.url));
  // tsx compiles on the fly, so the worker is loaded from source in dev and
  // from the same path in production — the extension is whatever this module's
  // own is.
  const entry = join(here, here.includes('/src/') ? 'worker.ts' : 'worker.js');

  prover.ready = new Promise<void>((resolve, reject) => {
    // Reading FdcLeaf's proving key back needs room for 2.6 GB plus what the
    // decoder allocates on top; the default heap dies with `Reached heap limit`
    // partway through the restore, which reads as a mysterious silent exit.
    const heapMb = process.env.PROVER_HEAP_MB ?? '12288';
    const child = fork(entry, [], {
      execArgv: [
        `--max-old-space-size=${heapMb}`,
        ...(entry.endsWith('.ts') ? ['--import', 'tsx'] : []),
      ],
      env: process.env,
    });
    prover.child = child;

    child.on('message', (message: Record<string, unknown>) => {
      if (message.type === 'ready') {
        console.log(`prover[${lane}] ready (compile ${Number(message.compileMs) / 1000}s)`);
        return resolve();
      }

      const entry = prover.pending.get(Number(message.id));
      if (entry === undefined) return;
      prover.pending.delete(Number(message.id));

      if (message.type === 'built') {
        entry.resolve({
          transaction: String(message.transaction),
          provingMs: Number(message.provingMs),
        });
      } else if (message.type === 'released') {
        entry.resolve({ transaction: String(message.hash), provingMs: 0 });
      } else {
        entry.reject(new Error(String(message.error)));
      }
    });

    // A prover that dies takes every in-flight request with it. Rejecting them
    // explicitly beats leaving the callers hanging until their client times
    // out, and the next request restarts it.
    const die = (reason: string) => {
      const error = new Error(`prover[${lane}] ${reason}`);
      for (const [, p] of prover.pending) p.reject(error);
      prover.pending.clear();
      prover.child = undefined;
      prover.ready = undefined;
      reject(error);
    };
    child.on('error', (error) => die(`failed: ${error.message}`));
    child.on('exit', (code) => code !== 0 && die(`exited with code ${code}`));
  });

  return prover.ready;
}

/**
 * Send one request and wait for its answer, serialised within its lane.
 *
 * Serialised because proving saturates the cores it is given: two concurrent
 * proofs in one process do not finish in the time of one, they finish in twice
 * the time, together.
 */
async function submit<T>(
  lane: Lane,
  message: (id: number) => Record<string, unknown>,
  pick: (built: BuiltDeposit) => T,
): Promise<T> {
  await start(lane);
  const prover = provers[lane];

  const run = async (): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      prover.pending.set(id, { resolve: (built) => resolve(pick(built)), reject });
      prover.child?.send(message(id));
    });
  };

  const result = prover.queue.then(run, run);
  prover.queue = result.catch(() => undefined);
  return result;
}

/** Build and prove a deposit. Resolves with an unsigned transaction. */
export async function buildDeposit(request: DepositRequest): Promise<BuiltDeposit> {
  return submit(
    'user',
    (id) => ({
      kind: 'deposit',
      id,
      sender: request.sender,
      recipient: request.recipient,
      amountNanomina: request.amountNanomina.toString(),
      nonce: request.nonce.toString(),
    }),
    (built) => built,
  );
}

/** How many requests are waiting or in flight. For the API to report a wait. */
/**
 * Build an unsigned burn of a wrapped asset.
 *
 * On the user lane, like a deposit: somebody is waiting at a wallet, and a
 * background publication must not make them wait behind it.
 */
export async function buildBurn(request: {
  sender: string;
  token: string;
  amount: bigint;
}): Promise<BuiltDeposit> {
  return submit(
    'user',
    (id) => ({
      kind: 'burn',
      id,
      sender: request.sender,
      token: request.token,
      amount: request.amount.toString(),
    }),
    (built) => ({ transaction: built.transaction, provingMs: built.provingMs }),
  );
}

export function queueDepth(): number {
  return provers.user.pending.size + provers.background.pending.size;
}

/**
 * Release escrowed MINA for a burn that already happened on Flare.
 *
 * Queued behind deposits on the same worker: proving saturates its cores, and
 * releases are serialised anyway because `releaseWithdrawal` advances the
 * bridge's cursor along Flare's chain. Returns the Mina transaction hash.
 */
/**
 * Push Flare's withdrawal chain state to the escrow.
 *
 * Queued on the same worker as everything else: proving saturates its cores,
 * and a release that lands before its state would fail anyway.
 */
export async function publishActionState(request: {
  /** ABI-encoded FDC response, hex without 0x. */
  response: string;
  /** Sibling hashes bottom to top, hex without 0x. */
  siblings: string[];
  calls: unknown[];
  /** Voters whose public keys are known, already checked against the policy. */
  keys: unknown[];
}): Promise<string> {
  return submit(
    'background',
    (id) => ({
      kind: 'publish',
      id,
      response: request.response,
      siblings: request.siblings,
      calls: request.calls,
      keys: request.keys,
    }),
    (built) => built.transaction,
  );
}

/** One link of the shared chain, as the prover replays it. */
export type ChainRecord = {
  index: bigint;
  /** Flare token address. Records of other assets are stepped over, not paid. */
  token: string;
  recipient: string;
  amount: bigint;
};

const wire = (r: ChainRecord) => ({
  index: r.index.toString(),
  token: r.token,
  recipient: r.recipient,
  amount: r.amount.toString(),
});

/**
 * Release the next withdrawal the escrow is entitled to.
 *
 * `range` is everything Flare committed to between the escrow's cursor and the
 * head it has accepted — every asset, in order. Which record gets paid is
 * decided inside the circuit, so nothing here names a recipient or an amount:
 * the order is not a convenience, a range in the wrong order reaches a
 * different head and is refused.
 */
export async function releaseWithdrawal(request: {
  range: ChainRecord[];
  /**
   * Send without waiting for inclusion, because more are following.
   *
   * The prover predicts the cursor its predecessor leaves and builds against it,
   * so a whole wave lands in one block. The caller confirms once at the end —
   * releases sent this way are not confirmed individually.
   */
  wave?: boolean;
  /** First of a wave: the prover drops its predictions and re-reads the chain. */
  restart?: boolean;
}): Promise<string> {
  return submit(
    'background',
    (id) => ({
      kind: 'release',
      id,
      range: request.range.map(wire),
      wave: request.wave,
      restart: request.restart,
    }),
    (built) => built.transaction,
  );
}

/**
 * Push one token's Flare lock-chain head to its Mina port.
 *
 * Queued on the same worker as everything else: proving saturates its cores,
 * and a mint that lands before its head would fail anyway.
 */
export async function publishLockState(request: {
  port: string;
  response: string;
  siblings: string[];
  calls: unknown[];
  keys: unknown[];
}): Promise<string> {
  return submit(
    'background',
    (id) => ({
      kind: 'publishLock',
      id,
      port: request.port,
      response: request.response,
      siblings: request.siblings,
      calls: request.calls,
      keys: request.keys,
    }),
    (built) => built.transaction,
  );
}

/**
 * Mint the next lock a port is entitled to. Returns the mint transaction's hash.
 *
 * Same shape as {releaseWithdrawal}: `range` spans the port's cursor to its
 * accepted head, and `asset` is what tells its own locks from the ones it steps
 * over.
 */
export async function mintLock(request: {
  port: string;
  token: string;
  /** Flare address of the asset this port administers. */
  asset: string;
  range: ChainRecord[];
}): Promise<string> {
  return submit(
    'background',
    (id) => ({
      kind: 'mint',
      id,
      port: request.port,
      token: request.token,
      asset: request.asset,
      range: request.range.map(wire),
    }),
    (built) => built.transaction,
  );
}
