import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyAttestation, type AttestedEvent } from '@minaport/shared';

/**
 * Getting Flare's validator set to sign our data.
 *
 * The signing-policy proof establishes that validators signed *a round*. This
 * is what puts our event inside one: request an `EVMTransaction` attestation of
 * the transaction that emitted it, wait for the round to finalise, and fetch
 * the response with its Merkle proof. The Mina circuit then hashes that
 * response, climbs the proof, and reads the action state out of the event —
 * so nothing is left for a key to assert.
 *
 * # Why the request is trimmed
 *
 * `provideInput: false` with a single `logIndices` entry yields a response of
 * 1344 bytes instead of 4064. In-circuit that is 10 keccak blocks instead of
 * 30, ~149,000 rows instead of ~440,000. The offsets the circuit reads are only
 * stable for this shape, which `parseAttestedEvent` checks.
 */

const RPC = process.env.COSTON2_RPC_URL ?? 'https://coston2-api.flare.network/ext/C/rpc';
const REGISTRY = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019' as const;

/**
 * Flare's public testnet services. Two of the three documented verifier URLs
 * answer `fault filter abort`; this is the one that works, and the source id
 * has to be `testFLR` to match it.
 */
const VERIFIER =
  process.env.FDC_VERIFIER_URL ??
  'https://fdc-verifiers-testnet.flare.network/verifier/flr/EVMTransaction/prepareRequest';
const DA_LAYER =
  process.env.FDC_DA_LAYER_URL ??
  'https://ctn2-data-availability.flare.network/api/v1/fdc/proof-by-request-round-raw';
const API_KEY = process.env.FDC_API_KEY ?? '00000000-0000-0000-0000-000000000000';

/** Left-padded UTF-8, which is how attestation types and sources are encoded. */
const ATTESTATION_TYPE =
  '0x45564d5472616e73616374696f6e000000000000000000000000000000000000' as const;
const SOURCE_ID = '0x74657374464c5200000000000000000000000000000000000000000000000000' as const;

const COSTON2 = {
  id: 114,
  name: 'Coston2',
  nativeCurrency: { name: 'Coston2 Flare', symbol: 'C2FLR', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const client = createPublicClient({ chain: COSTON2, transport: http(RPC) });

let contracts: { fdcHub: Hex; fees: Hex; relay: Hex } | undefined;

async function byName(name: string): Promise<Hex> {
  return client.readContract({
    address: REGISTRY,
    abi: parseAbi(['function getContractAddressByName(string) view returns (address)']),
    functionName: 'getContractAddressByName',
    args: [name],
  });
}

async function resolve() {
  contracts ??= {
    fdcHub: await byName('FdcHub'),
    fees: await byName('FdcRequestFeeConfigurations'),
    relay: await byName('Relay'),
  };
  return contracts;
}

/** The log index of our event within its transaction's block. */
export async function findEventLogIndex(
  txHash: Hex,
  emitter: Hex,
  topic0: Hex,
): Promise<number> {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const log = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === emitter.toLowerCase() &&
      l.topics[0]?.toLowerCase() === topic0.toLowerCase(),
  );
  if (log === undefined) {
    // Almost always an event emitted before its signature changed shape, which
    // resolves the moment a newer transfer moves the chain head — the tail
    // proof from the older record reaches the newer state anyway.
    throw new Error(
      `${txHash} has no ${topic0.slice(0, 10)}… event from ${emitter.slice(0, 10)}…; ` +
        'if it predates an event-shape change, the next transfer will cover it',
    );
  }
  return log.logIndex;
}

/**
 * Ask the verifier to encode a request.
 *
 * `logIndices` must hold **strings**. Numbers are rejected with a bare
 * `Bad Request` that names no field, which is a long way to spend an evening.
 */
export async function prepareRequest(txHash: Hex, logIndex: number): Promise<Hex> {
  const res = await fetch(VERIFIER, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-KEY': API_KEY },
    body: JSON.stringify({
      attestationType: ATTESTATION_TYPE,
      sourceId: SOURCE_ID,
      requestBody: {
        transactionHash: txHash,
        requiredConfirmations: '1',
        provideInput: false,
        listEvents: true,
        logIndices: [String(logIndex)],
      },
    }),
  });
  const body = (await res.json()) as { status?: string; abiEncodedRequest?: Hex };
  if (body.status !== 'VALID' || body.abiEncodedRequest === undefined) {
    throw new Error(`verifier refused the request: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.abiEncodedRequest;
}

/** Submit the request on chain, and say which voting round it landed in. */
export async function submitRequest(request: Hex): Promise<{ round: number; txHash: Hex }> {
  const key = process.env.FLARE_SUBMITTER_PRIVATE_KEY;
  if (!key) throw new Error('FLARE_SUBMITTER_PRIVATE_KEY is required to request attestations');

  const { fdcHub, fees, relay } = await resolve();
  const fee = await client.readContract({
    address: fees,
    abi: parseAbi(['function getRequestFee(bytes) view returns (uint256)']),
    functionName: 'getRequestFee',
    args: [request],
  });

  const wallet = createWalletClient({
    account: privateKeyToAccount(key as Hex),
    chain: COSTON2,
    transport: http(RPC),
  });
  const txHash = await wallet.writeContract({
    address: fdcHub,
    abi: parseAbi(['function requestAttestation(bytes) payable']),
    functionName: 'requestAttestation',
    args: [request],
    value: fee,
    // Coston2's pool floor is 500 gwei; anything under is silently underpriced.
    gasPrice: BigInt(process.env.FLARE_GAS_PRICE_WEI ?? 600_000_000_000),
  });

  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const round = await client.readContract({
    address: relay,
    abi: parseAbi(['function getVotingRoundId(uint256) view returns (uint32)']),
    functionName: 'getVotingRoundId',
    args: [block.timestamp],
  });

  return { round: Number(round), txHash };
}

export type Attestation = {
  /** ABI-encoded response, exactly as the DA layer serves it. */
  response: Hex;
  /** Sibling hashes, bottom to top. Sorted pairs. */
  proof: Hex[];
  /** Round root, read back from `Relay.merkleRoots(200, round)`. */
  root: Hex;
  round: number;
  event: AttestedEvent;
};

/**
 * Fetch the response and its proof once the round has finalised.
 *
 * Returns null while the round is still open — the FDC finalises roughly a
 * minute after a round closes, and a caller on a timer should simply come back.
 */
export async function fetchAttestation(
  request: Hex,
  round: number,
  expected: { emitter: Hex; topic0: Hex },
): Promise<Attestation | null> {
  const res = await fetch(DA_LAYER, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-KEY': API_KEY },
    body: JSON.stringify({ votingRoundId: round, requestBytes: request }),
  });
  const body = (await res.json()) as { response_hex?: Hex; proof?: Hex[] };
  if (body.response_hex === undefined || body.proof === undefined) return null;

  const { relay } = await resolve();
  const root = await client.readContract({
    address: relay,
    abi: parseAbi(['function merkleRoots(uint256,uint256) view returns (bytes32)']),
    functionName: 'merkleRoots',
    args: [200n, BigInt(round)],
  });

  // Checked here as well as in-circuit. Proving costs a minute; finding out
  // first that the DA layer served something inconsistent costs a request.
  const event = verifyAttestation(body.response_hex, body.proof, root, expected);

  return { response: body.response_hex, proof: body.proof, root, round, event };
}

/** The whole off-chain dance, for a transaction that emitted a bridge event. */
export async function requestAttestationFor(
  txHash: Hex,
  expected: { emitter: Hex; topic0: Hex },
): Promise<{ request: Hex; round: number }> {
  const logIndex = await findEventLogIndex(txHash, expected.emitter, expected.topic0);
  const request = await prepareRequest(txHash, logIndex);
  const { round } = await submitRequest(request);
  return { request, round };
}
