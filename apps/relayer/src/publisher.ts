import { createPublicClient, http, parseAbi, decodeEventLog, type Hex } from 'viem';
import {
  harvestPolicyKeys,
  knownWeight,
  parseRelayCalldata,
  signingPolicyHash,
  type PolicyKey,
  type RelayCall,
} from '@minaport/shared';
import { knownValidatorKeys, rememberValidatorKeys } from './db/index.js';
import { publishActionState } from './prover/index.js';

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

/** How often to check whether Flare's chain has moved. */
const POLL_MS = Number(process.env.PUBLISH_INTERVAL_MS ?? 60_000);

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
/** Last state pushed, so an unchanged chain costs no proving. */
let published: bigint | undefined;

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

  // Nothing burned since the last push; proving again would cost ECDSA for a
  // value Mina already holds.
  if (actionState === published || actionState === 0n) return;

  const calls = await recentRelayCalls();
  if (calls.length === 0) {
    console.warn('publisher: no relay transactions in the lookback window');
    return;
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
    return;
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
    return;
  }

  const hash = await publishActionState({ actionState, calls, keys });
  published = actionState;
  console.log(`published Flare action state ${actionState} -> ${hash}`);
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
