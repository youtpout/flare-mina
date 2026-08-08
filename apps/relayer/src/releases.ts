import { keccak256, encodeAbiParameters, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeMinaRecipient, formatMinaAddress } from '@minaport/shared';
import {
  markReleaseAttested,
  markReleaseFailed,
  reanchorPendingReleases,
  submittedReleases,
  type ReleaseRow,
} from './db/index.js';
import { assets } from './assets.js';

/**
 * The return leg for wrapped assets: a burn on Mina, released on Flare.
 *
 * Structurally the mirror of the deposit poller, and deliberately so. The
 * relayer built the burn, so it already knows every field — there is nothing to
 * reconstruct from the chain, only a yes/no to confirm, which is what keeps this
 * off an archive node.
 *
 * # What it can and cannot do
 *
 * It cannot redirect or inflate a release. The token, recipient and amount are
 * inside the holder's Schnorr signature, which `AssetVault` verifies against the
 * Pallas curve. A dishonest attestor can only refuse to sign, or sign for a burn
 * that never happened — the mirror of GAP 1, bounded on chain by the per-token
 * ceiling.
 *
 * # How a burn is confirmed
 *
 * By the holder's token balance having fallen by at least the amount since the
 * burn was built. A displaced transaction leaves it untouched, so this separates
 * "landed" from "never happened" without naming the transaction.
 *
 * Reading the burn event back would be the precise signal, and needs an archive
 * node. None of the public ones were reachable when this was written, so this is
 * the honest substitute — stronger than the one the deposit poller makes, which
 * only asks that the escrow holds enough.
 */

const GRAPHQL = process.env.MINA_GRAPHQL ?? 'https://mina-devnet-graphql.aurowallet.com/graphql';
const POLL_MS = Number(process.env.RELEASE_INTERVAL_MS ?? 20_000);
const CHAIN_ID = BigInt(process.env.FLARE_CHAIN_ID ?? 114);
const VAULT = process.env.FLARE_ASSET_VAULT_ADDRESS as Address | undefined;

/** Must match `AssetVault.RELEASE_INTENT_DOMAIN`. */
export const RELEASE_INTENT_DOMAIN: Hex = keccak256(toHex('FlareXMina.ReleaseIntent.v1'));

/**
 * The digest the attestor signs.
 *
 * Must match `AssetVault.releaseWithMinaSignature` byte for byte: the contract
 * recomputes it from its own arguments, so a mismatch is not a subtle bug but a
 * burn that can never be released.
 */
export function releaseIntentDigest(
  chainId: bigint,
  target: { minaSender: Hex; token: Address; recipient: Address; amount: bigint; nonce: bigint },
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint64' },
      ],
      [
        RELEASE_INTENT_DOMAIN,
        chainId,
        target.minaSender,
        target.token,
        target.recipient,
        target.amount,
        target.nonce,
      ],
    ),
  );
}

const ACCOUNT_QUERY = `
  query Account($publicKey: PublicKey!, $token: TokenId) {
    account(publicKey: $publicKey, token: $token) {
      nonce
      balance { total }
    }
  }
`;

async function readAccount(
  publicKey: string,
  token?: string,
): Promise<{ nonce: bigint; balance: bigint } | null> {
  try {
    const res = await fetch(GRAPHQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: ACCOUNT_QUERY, variables: { publicKey, token } }),
    });
    const body = (await res.json()) as {
      data?: { account?: { nonce?: string; balance?: { total?: string } } };
    };
    const account = body.data?.account;
    if (account === undefined || account === null) return null;
    return {
      nonce: BigInt(account.nonce ?? '0'),
      balance: BigInt(account.balance?.total ?? '0'),
    };
  } catch {
    return null;
  }
}

/** The asset a row is for, by its Flare token address. */
function assetFor(token: string) {
  return assets().find((a) => a.flareToken.toLowerCase() === token.toLowerCase());
}

/**
 * Attest the burns that landed.
 *
 * The check is that the holder's token balance has fallen by at least the
 * amount since the burn was anchored. Weaker than "this exact burn is on
 * chain", and deliberately not dressed up as more — but strictly stronger than
 * the inbound rail's, which only asks that the escrow holds enough.
 *
 * One per (holder, token) per tick, because attesting re-anchors the rest.
 * Several burns built before any of them landed share an anchor, and a single
 * drop would otherwise satisfy every one of their checks at once — three
 * pending rows of 4 against one burn of 4 releases twelve.
 */
async function tick(): Promise<void> {
  const key = process.env.ATTESTOR_PRIVATE_KEY as Hex | undefined;
  if (key === undefined || VAULT === undefined) return;
  const attestor = privateKeyToAccount(key);

  // Oldest first within each holder's token, so an anchor always describes the
  // balance the next burn in line is measured against.
  const queues = new Map<string, ReleaseRow[]>();
  for (const row of await submittedReleases()) {
    const key = `${row.mina_sender}|${row.token}`;
    queues.set(key, [...(queues.get(key) ?? []), row]);
  }

  for (const rows of queues.values()) {
    const row = rows[0]!;
    try {
      const asset = assetFor(row.token);
      if (asset?.tokenId === undefined) {
        await markReleaseFailed(row.id, `no port configured for ${row.token}`);
        continue;
      }
      if (row.balance_before === null) {
        await markReleaseFailed(row.id, 'built before balances were recorded');
        continue;
      }

      const holder = formatMinaAddress(decodeMinaRecipient(row.mina_sender as Hex));
      const amount = BigInt(row.amount);

      // A reaped token account reads as absent, which is a burn of everything
      // rather than a missing one — so treat it as zero, not as unknown.
      const balance = (await readAccount(holder, asset.tokenId))?.balance ?? 0n;
      if (balance > BigInt(row.balance_before) - amount) continue;

      const digest = releaseIntentDigest(CHAIN_ID, {
        minaSender: row.mina_sender as Hex,
        token: row.token as Address,
        recipient: row.recipient as Address,
        amount,
        nonce: BigInt(row.nonce),
      });

      const signature = await attestor.signMessage({ message: { raw: digest } });
      await markReleaseAttested(row.id, signature);
      // Everything still waiting on this token now measures from here.
      await reanchorPendingReleases(row.mina_sender, row.token, balance);
      console.log(`attested release ${row.id} -> ${row.recipient}`);
    } catch (e) {
      console.error(`release ${row.id} not attested:`, e instanceof Error ? e.message : e);
    }
  }
}

export function startReleases(): { stop(): void } {
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        await tick();
      } catch (e) {
        console.error('release tick failed:', e instanceof Error ? e.message : e);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };

  void loop();
  return { stop: () => (stopped = true) };
}
