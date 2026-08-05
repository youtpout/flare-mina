import { createPublicClient, http, parseAbi, decodeEventLog, type Hex } from 'viem';
import {
  harvestPolicyKeys,
  knownWeight,
  parseRelayCalldata,
  signingPolicyHash,
  type RelayCall,
} from '@minaport/shared';
import { buildPolicyTree } from '../src/policyTree.js';

/**
 * Produce the signing-policy root to publish on the Mina bridge.
 *
 * Run:
 *   npx tsx scripts/fetchPolicyTree.ts [blocksOfHistory]
 *
 * # Why it walks recent history instead of reading one place
 *
 * The authorised set is committed on chain as `toSigningPolicyHash`, but the
 * *contents* only appear in two places: a `SigningPolicyInitialized` event once
 * per reward epoch, and a copy inside every `relay()` transaction. Reward epochs
 * are ~3.5 days apart and the public RPC caps `getLogs` at 30 blocks, so
 * reaching that event costs thousands of calls. Relay transactions land every
 * 90 seconds.
 *
 * The copy is not taken on trust: its hash is checked against the on-chain
 * commitment before anything is built from it.
 *
 * A second reason to walk several rounds: a voter's public key is only knowable
 * once it has signed, and no single round contains every signer. More history
 * means more provable weight.
 */

const RPC = process.env.COSTON2_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const REGISTRY = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019' as const;

/** The public RPC rejects wider windows, reporting it only in `error.details`. */
const CHUNK = 30n;

const COSTON2 = {
  id: 114,
  name: 'Coston2',
  nativeCurrency: { name: 'Coston2 Flare', symbol: 'C2FLR', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const relayedAbi = parseAbi([
  'event ProtocolMessageRelayed(uint8 indexed protocolId, uint32 indexed votingRoundId, bool isSecureRandom, bytes32 merkleRoot)',
]);

async function main(): Promise<void> {
  const history = BigInt(process.argv[2] ?? 600);
  const client = createPublicClient({ chain: COSTON2, transport: http(RPC) });

  const relay = await client.readContract({
    address: REGISTRY,
    abi: parseAbi(['function getContractAddressByName(string) view returns (address)']),
    functionName: 'getContractAddressByName',
    args: ['Relay'],
  });
  console.log(`Relay        ${relay}`);

  const head = await client.getBlockNumber();
  const calls: RelayCall[] = [];
  const seen = new Set<Hex>();

  for (let start = head - history; start <= head; start += CHUNK) {
    const end = start + CHUNK - 1n > head ? head : start + CHUNK - 1n;
    for (const log of await client.getLogs({ address: relay, fromBlock: start, toBlock: end })) {
      try {
        if (decodeEventLog({ abi: relayedAbi, ...log }).eventName !== 'ProtocolMessageRelayed') {
          continue;
        }
      } catch {
        continue;
      }
      // One transaction can relay several protocols; its calldata is the same.
      if (seen.has(log.transactionHash)) continue;
      seen.add(log.transactionHash);
      const tx = await client.getTransaction({ hash: log.transactionHash });
      calls.push(parseRelayCalldata(tx.input));
    }
  }

  if (calls.length === 0) throw new Error(`no relay transactions in the last ${history} blocks`);
  console.log(`transactions ${calls.length} over ${history} blocks`);

  // Newest epoch present, in case the window straddles a boundary.
  const rewardEpochId = Math.max(...calls.map((c) => c.policy.rewardEpochId));
  const policy = calls.find((c) => c.policy.rewardEpochId === rewardEpochId)!.policy;

  // The authority check. Everything after this is derived from a set Flare
  // itself commits to, rather than from whatever a transaction happened to
  // carry.
  const onChain = await client.readContract({
    address: relay,
    abi: parseAbi(['function toSigningPolicyHash(uint256) view returns (bytes32)']),
    functionName: 'toSigningPolicyHash',
    args: [BigInt(rewardEpochId)],
  });
  const computed = signingPolicyHash(policy);
  if (computed.toLowerCase() !== onChain.toLowerCase()) {
    throw new Error(`signing policy does not match the on-chain commitment for epoch ${rewardEpochId}`);
  }
  console.log(`epoch        ${rewardEpochId}  (policy hash verified)`);

  const { known, missing } = await harvestPolicyKeys(policy, calls);
  const total = policy.voters.reduce((sum, v) => sum + v.weight, 0);
  const tree = buildPolicyTree(known);

  console.log(`voters       ${known.length}/${policy.voters.length} with known keys`);
  console.log(`weight       ${knownWeight(known)} / ${total}   threshold ${policy.threshold}`);
  if (missing.length > 0) {
    console.log(`missing      ${missing.map((v) => `${v.index}(w=${v.weight})`).join(' ')}`);
  }
  console.log(`root         ${tree.root.toString()}`);

  if (tree.provableWeight < policy.threshold) {
    console.log(
      '\nNOTE: the known keys cannot reach the threshold. Publishing this root is safe —' +
        '\nan incomplete tree only lowers the weight a fold can prove — but no proof will' +
        '\nclear the real threshold until more voters have been observed signing.' +
        '\nRe-run with a wider window, e.g. `npx tsx scripts/fetchPolicyTree.ts 3000`.',
    );
  }
}

await main();
