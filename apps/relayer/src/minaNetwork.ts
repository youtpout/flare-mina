/**
 * Which Mina network the relayer talks to, in one place.
 *
 * The endpoints used to be a default string repeated in eight files, so moving
 * to Mesa meant finding all eight. Now it is `MINA_NETWORK=mesa`, and any
 * single endpoint can still be overridden on its own.
 *
 * Two endpoints rather than one because they answer different questions, and
 * on devnet the better node for each is not the same:
 *
 *   node    o1js `Network`, account fetches, sending transactions
 *   reads   raw `zkappState` polling by the watchers
 *
 * Mesa currently publishes one endpoint, so both point at it.
 */

export type MinaNetworkName = 'devnet' | 'mesa';

type NetworkConfig = {
  /** Endpoint o1js is configured with. */
  node: string;
  /** Endpoint the state watchers poll. */
  reads: string;
  /** Archive node, when one is published. Absent means event history is not readable. */
  archive?: string;
  /** Block explorer base, for logs and links. Absent means none exists yet. */
  explorer?: string;
};

const NETWORKS: Record<MinaNetworkName, NetworkConfig> = {
  devnet: {
    // Not minascan's node here: it answers most token accounts in ~200ms and
    // then times out on others every single time.
    node: 'https://mina-devnet-graphql.aurowallet.com/graphql',
    reads: 'https://api.minascan.io/node/devnet/v1/graphql',
    explorer: 'https://minascan.io/devnet',
  },
  mesa: {
    node: 'https://mesa.minataur.net/graphql',
    reads: 'https://mesa.minataur.net/graphql',
    archive: 'https://archive-node-api.mesa-rc.minaprotocol.com/',
    explorer: 'https://minascan.io/mesa',
  },
};

function resolve(): MinaNetworkName {
  const raw = process.env.MINA_NETWORK ?? 'devnet';
  if (raw !== 'devnet' && raw !== 'mesa') {
    throw new Error(`MINA_NETWORK must be 'devnet' or 'mesa', got '${raw}'`);
  }
  return raw;
}

export const MINA_NETWORK: MinaNetworkName = resolve();

const config = NETWORKS[MINA_NETWORK];

/** o1js `Network` endpoint. `MINA_GRAPHQL` overrides it. */
export const MINA_NODE_GRAPHQL = process.env.MINA_GRAPHQL ?? config.node;

/**
 * Endpoint the watchers poll for `zkappState`.
 *
 * Still honours `MINA_DEVNET_GRAPHQL`, which is what every existing deployment
 * sets — renaming it would have broken the running server for no gain.
 */
export const MINA_READ_GRAPHQL =
  process.env.MINA_READ_GRAPHQL ?? process.env.MINA_DEVNET_GRAPHQL ?? config.reads;

/** Archive node, if this network has one. */
export const MINA_ARCHIVE = process.env.MINA_ARCHIVE ?? config.archive;

/** Explorer base, if this network has one. */
export const MINA_EXPLORER = process.env.MINA_EXPLORER ?? config.explorer;

export function describeMinaNetwork(): string {
  const parts = [`network=${MINA_NETWORK}`, `node=${MINA_NODE_GRAPHQL}`];
  if (MINA_READ_GRAPHQL !== MINA_NODE_GRAPHQL) parts.push(`reads=${MINA_READ_GRAPHQL}`);
  if (MINA_ARCHIVE) parts.push('archive=yes');
  return parts.join(' ');
}
