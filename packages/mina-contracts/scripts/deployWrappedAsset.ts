import { appendFileSync } from 'node:fs';
import {
  Bool,
  AccountUpdate,
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  UInt8,
  UInt64,
  fetchAccount,
} from 'o1js';
import { FungibleToken } from 'mina-fungible-token';
import { AssetPort } from '../src/AssetPort.js';
import { TransferChain } from '../src/TransferChain.js';
import { SigningPolicyFold } from '../src/SigningPolicyFold.js';
import { RelayMessage } from '../src/RelayMessage.js';
import { MerkleInclusion } from '../src/MerkleInclusion.js';
import { FdcLeaf, FdcAttestation } from '../src/FdcAttestation.js';

/**
 * Deploy a wrapped Flare asset on Mina: one `FungibleToken` plus the `AssetPort`
 * that governs its minting.
 *
 * This is the Flare -> Mina direction — the one the product exists for. Mina has
 * assets but little DeFi; Flare has FXRP and USD₮0 and a working ecosystem, and
 * this is what brings that liquidity across.
 *
 * # Why two contracts
 *
 * `FungibleToken` is the standard; `AssetPort` decides who may mint. It trusts
 * no key for that decision: a mint has to be the next link in the Poseidon lock
 * chain `AssetVault` builds on Flare, ending at a head the Flare validator set
 * signed. The admin key publishes that head and nothing else — it cannot choose
 * a recipient, an amount, or skip a link.
 *
 * # Decimals are never converted
 *
 * The wrapper takes the underlying's decimals verbatim, so `100000` base units
 * is `0.1 USDT` on both chains and the invariant is an integer comparison. FXRP
 * and USD₮0 are both 6, which `UInt64` holds 18 trillion of. C2FLR is 18 and
 * must cross through `BridgeWrapper` on the Flare side first, which is why its
 * port is deployed against `bWC2FLR` at 9.
 *
 * # A new port starts at the beginning of the chain
 *
 * `processedLockState` initialises to zero, and the Flare `TransferChain` is
 * shared and long-lived. So a port deployed against a chain that already has
 * history must replay every past lock of its asset — two proofs and two blocks
 * each, minting to whoever locked back then — before it reaches anything
 * current. Redeploying three ports cost hours of that.
 *
 * Fast-forward it afterwards, unless replaying really is what you want:
 *   node dist/scripts/migrateState.js set-cursor BFXRP <head>
 *
 * Usage, from the repository root:
 *   set -a && . ./.env && set +a
 *   pnpm --filter @minaport/mina-contracts exec tsx \
 *     scripts/deployWrappedAsset.ts bFXRP 6
 */

const GRAPHQL =
  process.env.MINA_DEVNET_GRAPHQL ?? 'https://devnet-plain-1.gcp.o1test.net/graphql';
const FEE = 200_000_000; // 0.2 MINA

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — source .env first`);
  return value;
}

async function main() {
  const [symbol, decimalsRaw] = process.argv.slice(2);
  if (symbol === undefined || decimalsRaw === undefined) {
    throw new Error('usage: deployWrappedAsset.ts <SYMBOL> <DECIMALS>');
  }
  const decimals = Number(decimalsRaw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
    // Above 9, a supply that fits on Flare does not fit in Mina's UInt64.
    throw new Error(`decimals must be 0..9; ${decimalsRaw} needs a Flare-side wrapper first`);
  }

  Mina.setActiveInstance(Mina.Network(GRAPHQL));

  const deployerKey = PrivateKey.fromBase58(required('MINA_DEVNET_PRIVATE_KEY'));
  const deployer = deployerKey.toPublicKey();

  // The port's admin publishes attested lock-chain heads and rotates the policy
  // root. Separate from the deployer on purpose: it is the one key with a
  // standing privilege here, small as that privilege is.
  const admin = PublicKey.fromBase58(
    process.env.MINA_LOCK_ADMIN ?? process.env.MINA_WITHDRAWAL_ATTESTOR ?? deployer.toBase58(),
  );

  // The policy root and the weight must match whatever the relayer publishes,
  // so they come from the same environment the MINA rail already uses.
  const signingPolicyRoot = Field(process.env.MINA_SIGNING_POLICY_ROOT ?? '0');

  // The vault whose events this port accepts. Pinned in state, so an event from
  // any other contract cannot advance this asset's chain.
  // The shared chain whose events this port accepts, and the one asset it
  // administers — every port reads the same chain, so the asset is what
  // separates them.
  const flareChain = Field(BigInt(required('FLARE_TRANSFER_CHAIN_ADDRESS')));
  const asset = Field(BigInt(required(`FLARE_${symbol.toUpperCase()}_ADDRESS`)));
  const requiredWeight = UInt64.from(BigInt(process.env.MINA_REQUIRED_WEIGHT ?? '0'));

  const tokenKey = PrivateKey.random();
  const portKey = PrivateKey.random();

  console.log(`deploying wrapped ${symbol} (${decimals} decimals)`);
  console.log('deployer       :', deployer.toBase58());
  console.log('admin          :', admin.toBase58());
  console.log('chain          :', flareChain.toBigInt().toString(16));
  console.log('asset          :', asset.toBigInt().toString(16));
  console.log('policy root    :', signingPolicyRoot.toString());
  console.log('requiredWeight :', requiredWeight.toString());
  console.log('token          :', tokenKey.toPublicKey().toBase58());
  console.log('port           :', portKey.toPublicKey().toBase58());
  // Appended, not just printed. The devnet rail deployed before this line
  // existed lost both keys to a closed terminal, and a zkApp whose key is gone
  // can never be given a new verification key — the next o1js bump strands it.
  const network = process.env.MINA_NETWORK ?? 'devnet';
  const keyFile = new URL(`.deployed-${network}.env`, import.meta.url);
  appendFileSync(
    keyFile,
    `\n# ${symbol}\nMINA_${symbol.toUpperCase()}_TOKEN=${tokenKey.toPublicKey().toBase58()}\n` +
      `MINA_${symbol.toUpperCase()}_TOKEN_KEY=${tokenKey.toBase58()}\n` +
      `MINA_${symbol.toUpperCase()}_PORT=${portKey.toPublicKey().toBase58()}\n` +
      `MINA_${symbol.toUpperCase()}_PORT_KEY=${portKey.toBase58()}\n`,
  );
  console.log('keys written to', keyFile.pathname, '(gitignored)\n');

  // Set before compiling, as the e2e test does: the token resolves its admin
  // class through this, and the deploy transaction reads it.
  FungibleToken.AdminContract = AssetPort as never;

  console.log('compiling…');
  // o1js 3 requires every dependency to be compiled before its dependent, and
  // reports the missing one rather than pulling it in. This is the worker's
  // order, which is the one known to satisfy the whole graph:
  // AssetPort needs FdcAttestation, which needs FdcLeaf and MerkleInclusion;
  // SigningPolicyFold needs RelayMessage.
  await TransferChain.compile();
  await RelayMessage.compile();
  await MerkleInclusion.compile();
  await SigningPolicyFold.compile();
  await FdcLeaf.compile();
  await FdcAttestation.compile();
  await AssetPort.compile();
  await FungibleToken.compile();

  await fetchAccount({ publicKey: deployer });

  const token = new FungibleToken(tokenKey.toPublicKey());
  const port = new AssetPort(portKey.toPublicKey());

  // The token resolves its admin by address, so the port has to be deployed in
  // the same transaction — an undeployed account yields an empty PublicKey that
  // is not a curve point.
  console.log('building…');
  const tx = await Mina.transaction({ sender: deployer, fee: FEE }, async () => {
    AccountUpdate.fundNewAccount(deployer, 3);
    await port.deploy({ admin, flareChain, asset, signingPolicyRoot, requiredWeight });
    await token.deploy({
      symbol,
      src: 'https://github.com/youtpout/flare-mina',
      // Immutable. The whole point of the port is that minting is governed by a
      // proof rather than a key; leaving the token's verification key swappable
      // would hand that key back the authority the design just took away.
      allowUpdates: false,
    });
    await token.initialize(portKey.toPublicKey(), UInt8.from(decimals), Bool(false));
  });

  console.log('proving…');
  await tx.prove();

  console.log('sending…');
  const pending = await tx.sign([deployerKey, tokenKey, portKey]).send();
  console.log('tx hash :', pending.hash);
  // The network is a setting now, so hardcoding devnet here printed a link
  // to the wrong chain for every Mesa deployment.
  const explorer = process.env.MINA_NETWORK === 'mesa' ? 'mesa' : 'devnet';
  console.log(`explorer: https://minascan.io/${explorer}/tx/${pending.hash}`);
}

await main();
