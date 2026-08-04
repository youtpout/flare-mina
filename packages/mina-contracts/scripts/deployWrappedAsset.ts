import {
  Bool,
  AccountUpdate,
  Field,
  Mina,
  MerkleTree,
  PrivateKey,
  PublicKey,
  UInt8,
  fetchAccount,
} from 'o1js';
import { FungibleToken } from 'mina-fungible-token';
import { BridgeTokenAdmin, CLAIM_TREE_HEIGHT } from '../src/BridgeTokenAdmin.js';

/**
 * Deploy a wrapped Flare asset on Mina: one `FungibleToken` plus the admin that
 * governs its minting.
 *
 * This is the Flare -> Mina direction — the one the product exists for. Mina
 * has assets but little DeFi; Flare has FXRP and USD₮0 and a working ecosystem,
 * and this is what brings that liquidity across.
 *
 * # Why two contracts
 *
 * `FungibleToken` is the standard; `BridgeTokenAdmin` is what decides who may
 * mint. It trusts no key: `canMint` verifies that the mint in front of it is
 * exactly the one a user authorised by proving their Flare-side lock is in
 * `lockRoot` and that their claim id has not been consumed. The attestor can
 * publish a root and nothing else — it cannot choose a recipient or an amount.
 *
 * # Decimals are never converted
 *
 * The wrapper takes the underlying's decimals verbatim, so `100000` base units
 * is `0.1 USDT` on both chains and the invariant is an integer comparison.
 * FXRP and USD₮0 are both 6, which `UInt64` holds 18 trillion of. An
 * 18-decimal token would overflow and must cross through `BridgeWrapper` on
 * the Flare side first.
 *
 * Usage, from the repository root:
 *   set -a && . ./.env && set +a
 *   pnpm --filter @minaport/mina-contracts exec tsx \
 *     scripts/deployWrappedAsset.ts FXRP 6 "Wrapped FXRP"
 */

const GRAPHQL =
  process.env.MINA_DEVNET_GRAPHQL ?? 'https://mina-devnet-graphql.aurowallet.com/graphql';
const FEE = 200_000_000; // 0.2 MINA

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — source .env first`);
  return value;
}

async function main() {
  const [symbol, decimalsRaw] = process.argv.slice(2);
  if (symbol === undefined || decimalsRaw === undefined) {
    throw new Error('usage: deployWrappedAsset.ts <SYMBOL> <DECIMALS> [NAME]');
  }
  const decimals = Number(decimalsRaw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
    // Above 9, a supply that fits on Flare does not fit in Mina's UInt64.
    throw new Error(`decimals must be 0..9; ${decimalsRaw} needs a Flare-side wrapper first`);
  }

  Mina.setActiveInstance(Mina.Network(GRAPHQL));

  const deployerKey = PrivateKey.fromBase58(required('MINA_DEVNET_PRIVATE_KEY'));
  const deployer = deployerKey.toPublicKey();

  // The attestor publishes lock roots. Separate from the deployer on purpose:
  // it is the one key with a standing privilege here, small as that privilege
  // is, and an admin that is also the attestor collapses two roles into one.
  const attestor = PublicKey.fromBase58(
    process.env.MINA_LOCK_ATTESTOR ?? process.env.MINA_WITHDRAWAL_ATTESTOR ?? deployer.toBase58(),
  );

  const tokenKey = PrivateKey.random();
  const adminKey = PrivateKey.random();

  // Both trees start empty: no lock has been published, nothing consumed.
  const empty = new MerkleTree(CLAIM_TREE_HEIGHT).getRoot();

  console.log(`deploying wrapped ${symbol} (${decimals} decimals)`);
  console.log('deployer :', deployer.toBase58());
  console.log('attestor :', attestor.toBase58());
  console.log('token    :', tokenKey.toPublicKey().toBase58());
  console.log('admin    :', adminKey.toPublicKey().toBase58());
  console.log('\nprivate keys (store them, they are not recoverable):');
  console.log('  token :', tokenKey.toBase58());
  console.log('  admin :', adminKey.toBase58(), '\n');

  console.log('compiling…');
  await BridgeTokenAdmin.compile();
  await FungibleToken.compile();

  await fetchAccount({ publicKey: deployer });

  const token = new FungibleToken(tokenKey.toPublicKey());
  const admin = new BridgeTokenAdmin(adminKey.toPublicKey());

  console.log('building…');
  const tx = await Mina.transaction({ sender: deployer, fee: FEE }, async () => {
    AccountUpdate.fundNewAccount(deployer, 3);
    await admin.deploy({ attestor, lockRoot: empty, nullifierRoot: empty });
    await token.deploy({
      symbol,
      src: 'https://github.com/youtpout/flare-mina',
      // Immutable. The whole point of the admin contract is that minting is
      // governed by a proof rather than a key; leaving the verification key
      // swappable by the deployer would hand that key back the authority the
      // design just took away from it.
      allowUpdates: false,
    });
    await token.initialize(adminKey.toPublicKey(), UInt8.from(decimals), Bool(false));
  });

  console.log('proving…');
  await tx.prove();

  console.log('sending…');
  const pending = await tx.sign([deployerKey, tokenKey, adminKey]).send();
  console.log('tx hash :', pending.hash);
  console.log('explorer: https://minascan.io/devnet/tx/' + pending.hash);
}

await main();
