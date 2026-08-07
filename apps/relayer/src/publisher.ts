import { createPublicClient, http, parseAbi, decodeEventLog, type Hex } from 'viem';
import {
  harvestPolicyKeys,
  knownWeight,
  parseRelayCalldata,
  signingPolicyHash,
  type PolicyKey,
  type RelayCall,
} from '@minaport/shared';
import { knownValidatorKeys, rememberValidatorKeys, withdrawalTxFor } from './db/index.js';
import { publishActionState } from './prover/index.js';
import { fetchAttestation, requestAttestationFor, type Attestation } from './fdc.js';

/**
 * Carries Flare's withdrawal chain state to Mina.
 *
 * The escrow releases against `flareActionState`, so without this nothing is
 * ever releasable. Runs on its own timer because establishing the state costs
 * ECDSA proving and is identical for every withdrawal in the batch it covers.
 */

const RPC = process.env.COSTON2_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const BRIDGE = process.env.FLARE_BRIDGE_ADDRESS as `0x${string}` | undefined;
const REGISTRY = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019' as const;

/**
 * How often to publish, when there is anything to publish.
 *
 * Fifteen minutes. A cycle is not cheap: an attestation request, a round to
 * finalise, then hashing 1344 bytes and climbing a Merkle path in-circuit —
 * several minutes of proving, per chain that moved. A publication covers every
 * transfer accumulated since the last one, so a shorter cadence buys latency
 * for one user and pays for it in work the whole bridge shares. Nothing is
 * emitted when a chain has not moved, so a quiet bridge costs nothing.
 */
const POLL_MS = Number(process.env.PUBLISH_INTERVAL_MS ?? 15 * 60_000);

/** The public RPC rejects wider `getLogs` windows. */
const CHUNK = 30n;

/** Blocks of Relay history to gather signatures from. */
const RELAY_LOOKBACK = BigInt(process.env.RELAY_LOOKBACK_BLOCKS ?? 300);

const COSTON2 = {
  id: 114,
  name: 'Coston2',
  nativeCurrency: { name: 'Coston2 Flare', symbol: 'C2FLR', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const relayedAbi = parseAbi([
  'event ProtocolMessageRelayed(uint8 indexed protocolId, uint32 indexed votingRoundId, bool isSecureRandom, bytes32 merkleRoot)',
]);

const client = createPublicClient({ chain: COSTON2, transport: http(RPC) });

let relayAddress: `0x${string}` | undefined;

const MINA_GRAPHQL =
  process.env.MINA_DEVNET_GRAPHQL ?? 'https://api.minascan.io/node/devnet/v1/graphql';
const ESCROW = process.env.MINA_BRIDGE_ACCOUNT;

/**
 * The state the escrow has actually accepted, read from Mina.
 *
 * Tracked on chain rather than in memory: a restart would otherwise forget what
 * it had published and send a second transaction for the same state, and the
 * two collide on the fee payer's nonce so one is simply lost.
 *
 * `zkappState[3]` is `flareActionState` — see the field order in
 * MinaPortBridge.ts. Returns null when the account cannot be read, which is
 * treated as "do not publish" rather than "publish again".
 */
async function acceptedActionState(): Promise<bigint | null> {
  if (ESCROW === undefined) return null;
  try {
    const res = await fetch(MINA_GRAPHQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ account(publicKey: "${ESCROW}") { zkappState } }`,
      }),
    });
    const body = (await res.json()) as { data?: { account?: { zkappState?: string[] } } };
    const state = body.data?.account?.zkappState?.[3];
    return state === undefined ? null : BigInt(state);
  } catch {
    return null;
  }
}

/**
 * The last state we sent, and when.
 *
 * Sending twice would have the two fight over the fee payer's nonce, so a
 * publication in flight blocks the next tick. But `send()` resolves even for a
 * transaction that is then included and rejected, so a marker kept until an
 * exception is a marker kept forever — the bridge stops retrying and looks
 * healthy while doing nothing. It expires instead.
 */
let inFlight: { state: bigint; at: number } | undefined;

/** Long enough for devnet inclusion, short enough that a rejection is retried. */
const IN_FLIGHT_TTL_MS = Number(process.env.PUBLISH_IN_FLIGHT_TTL_MS ?? 12 * 60_000);

/**
 * `WithdrawToMina(uint256,address,address,bytes32,uint256,uint256,uint256)`.
 *
 * Shaped like `AssetLocked` on purpose: the Mina circuit takes a fixed-size
 * response, and an event one data word narrower produced 41 words where it
 * wanted 42 — which does not fit the type at all.
 */
const WITHDRAW_TOPIC0 =
  '0x24d2ab5dabaa1673e788a746c4b8f40f36eb193072203823ceff2f3f1b997191' as const;

/**
 * Get the round that carries our event, waiting for it to finalise.
 *
 * The FDC settles a round roughly a minute after it closes, so this polls
 * inside the tick rather than deferring to the next one — ten more minutes of
 * latency for a wait that is usually under three.
 */
async function attestationFor(txHash: `0x${string}`): Promise<Attestation | null> {
  if (BRIDGE === undefined) return null;
  const expected = { emitter: BRIDGE, topic0: WITHDRAW_TOPIC0 };

  const { request, round } = await requestAttestationFor(txHash, expected);
  console.log(`requested attestation for ${txHash} in round ${round}`);

  const deadline = Date.now() + Number(process.env.FDC_WAIT_MS ?? 5 * 60_000);
  while (Date.now() < deadline) {
    const attestation = await fetchAttestation(request, round, expected);
    if (attestation !== null) return attestation;
    await new Promise((r) => setTimeout(r, 20_000));
  }
  console.warn(`round ${round} did not finalise in time; will retry next tick`);
  return null;
}

async function relay(): Promise<`0x${string}`> {
  relayAddress ??= await client.readContract({
    address: REGISTRY,
    abi: parseAbi(['function getContractAddressByName(string) view returns (address)']),
    functionName: 'getContractAddressByName',
    args: ['Relay'],
  });
  return relayAddress;
}

/** Recent `relay()` transactions, which is the only place signatures exist. */
async function recentRelayCalls(): Promise<RelayCall[]> {
  const address = await relay();
  const head = await client.getBlockNumber();
  const calls: RelayCall[] = [];
  const seen = new Set<Hex>();

  for (let start = head - RELAY_LOOKBACK; start <= head; start += CHUNK) {
    const end = start + CHUNK - 1n > head ? head : start + CHUNK - 1n;
    for (const log of await client.getLogs({ address, fromBlock: start, toBlock: end })) {
      try {
        if (decodeEventLog({ abi: relayedAbi, ...log }).eventName !== 'ProtocolMessageRelayed') {
          continue;
        }
      } catch {
        continue;
      }
      if (seen.has(log.transactionHash)) continue;
      seen.add(log.transactionHash);
      const tx = await client.getTransaction({ hash: log.transactionHash });
      calls.push(parseRelayCalldata(tx.input));
    }
  }
  return calls;
}

async function tick(): Promise<void> {
  if (BRIDGE === undefined) return;

  const actionState = await client.readContract({
    address: BRIDGE,
    abi: parseAbi(['function withdrawalActionState() view returns (uint256)']),
    functionName: 'withdrawalActionState',
  });

  if (actionState === 0n) return;

  // Already accepted on Mina, or already sent and waiting for inclusion —
  // devnet takes minutes, and a second send would only fight the first for the
  // fee payer's nonce.
  const accepted = await acceptedActionState();
  if (accepted === null || accepted === actionState) return;
  if (inFlight?.state === actionState && Date.now() - inFlight.at < IN_FLIGHT_TTL_MS) return;

  // The transaction whose event produced the state we are about to publish.
  // Its `newActionState` is what the circuit will read, so the row and the
  // chain have to agree before a proof is worth building.
  const txHash = (await withdrawalTxFor(actionState)) as `0x${string}` | null;
  if (txHash === null) {
    console.warn(`no recorded withdrawal produced state ${actionState}`);
    return;
  }

  const attestation = await attestationFor(txHash);
  if (attestation === null) return;
  if (attestation.event.newActionState !== actionState) {
    console.warn('the attested event carries a different state than the bridge reports');
    return;
  }

  const inputs = await policyProofInputs(attestation.round);
  if (inputs === null) return;
  const { calls, keys } = inputs;

  inFlight = { state: actionState, at: Date.now() };
  try {
    const hash = await publishActionState({
      response: attestation.response.slice(2),
      siblings: attestation.proof.map((p) => p.slice(2)),
      calls,
      keys,
    });
    console.log(`published Flare action state ${actionState} -> ${hash}`);
  } catch (e) {
    inFlight = undefined;
    throw e;
  }
}

/**
 * Everything a signing-policy proof needs: the relay calls that carry the
 * signatures, and the validator keys recovered from them.
 *
 * Shared with the asset rail, which proves against the same validator set. Null
 * when the window holds nothing usable or the known keys fall short of the
 * threshold — refusing beats publishing something weaker than the network
 * requires.
 */
export async function policyProofInputs(
  votingRoundId: number,
): Promise<{ calls: RelayCall[]; keys: PolicyKey[] } | null> {
  // The round the attestation is in, and no other. The signatures prove which
  // root the validators signed, and an inclusion path only reaches *that*
  // round's root — proving against whichever round happened to carry the most
  // signatures fails inside the circuit, and only there.
  const calls = (await recentRelayCalls()).filter(
    (c) => c.message.protocolId === 200 && c.message.votingRoundId === votingRoundId,
  );
  if (calls.length === 0) {
    console.warn(`publisher: no relay transaction found for FDC round ${votingRoundId}`);
    return null;
  }

  // Newest epoch present, in case the window straddles a boundary.
  const policy = calls.reduce((a, b) =>
    a.policy.rewardEpochId >= b.policy.rewardEpochId ? a : b,
  ).policy;

  // The authority check: a copy of the validator set carried in calldata means
  // nothing until it matches the commitment the chain stores for that epoch.
  const onChain = await client.readContract({
    address: await relay(),
    abi: parseAbi(['function toSigningPolicyHash(uint256) view returns (bytes32)']),
    functionName: 'toSigningPolicyHash',
    args: [BigInt(policy.rewardEpochId)],
  });
  if (signingPolicyHash(policy).toLowerCase() !== onChain.toLowerCase()) {
    console.warn(`publisher: policy for epoch ${policy.rewardEpochId} does not match on chain`);
    return null;
  }

  // Fresh recoveries from this window, plus everything ever seen. Coverage only
  // grows; without the stored half it would depend on which validators happened
  // to sign inside the lookback.
  const fresh = (await harvestPolicyKeys(policy, calls)).known;
  await rememberValidatorKeys(fresh);
  const stored = await knownValidatorKeys();

  const keys: PolicyKey[] = policy.voters.flatMap((voter) => {
    const publicKey = stored.get(voter.address.toLowerCase());
    return publicKey === undefined ? [] : [{ ...voter, publicKey: publicKey as `0x${string}` }];
  });

  if (knownWeight(keys) < policy.threshold) {
    console.warn(
      `publisher: known keys carry ${knownWeight(keys)} of ${policy.threshold} required`,
    );
    return null;
  }

  return { calls, keys };
}

export function startPublisher(): { stop(): void } {
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        await tick();
      } catch (e) {
        console.error('publisher tick failed:', e instanceof Error ? e.message : e);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };

  void loop();
  return { stop: () => (stopped = true) };
}
