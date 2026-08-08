import {
  AccountUpdate,
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  fetchAccount,
  initializeBindings,
  setBackend,
} from 'o1js';
import { adminCommitment } from '../src/AssetPort.js';
import { FungibleToken } from 'mina-fungible-token';
import { AssetPort } from '../src/AssetPort.js';
import { FdcAttestation, FdcLeaf } from '../src/FdcAttestation.js';
import { TransferChain } from '../src/TransferChain.js';
import { MerkleInclusion } from '../src/MerkleInclusion.js';
import { MinaPortBridge } from '../src/MinaPortBridge.js';
import { RelayMessage } from '../src/RelayMessage.js';
import { SigningPolicyFold } from '../src/SigningPolicyFold.js';
import { StateMigration } from '../src/StateMigration.js';

/**
 * Rearrange a deployed zkApp's state, then install its new circuit.
 *
 * A verification-key swap leaves state untouched, so a contract whose `@state`
 * declarations changed shape reads every slot after the change as the wrong
 * value. Three transactions fix it: install {StateMigration}, rewrite the eight
 * slots, install the real key.
 *
 * The account keeps its address and its balance throughout. That matters more
 * than it sounds: `FMINA.BRIDGE` on Flare is immutable, so a fresh escrow would
 * strand both the collateral and the rail.
 *
 * Usage, from the repository root:
 *   set -a && . ./.env && set +a
 *   pnpm --filter @minaport/mina-contracts exec node dist/scripts/migrateState.js bridge
 *   pnpm --filter @minaport/mina-contracts exec node dist/scripts/migrateState.js port BFXRP
 *
 * From `dist`, not tsx: tsx emits no decorator metadata and every `@method`
 * class fails to load without it.
 */

const GRAPHQL =
  process.env.MINA_DEVNET_GRAPHQL ?? 'https://api.minascan.io/node/devnet/v1/graphql';
const FEE = 200_000_000;

/**
 * The Flare token a port administers, from `MINA_ASSET_PORTS`.
 *
 * Read from the port list rather than its own variable: that list already pairs
 * every symbol with its Flare address, and a second copy is a second thing to
 * get wrong — a mismatch here would point a port at the wrong asset's transfers.
 */
function flareTokenOf(symbol: string): string {
  const ports = JSON.parse(required('MINA_ASSET_PORTS')) as Array<{
    symbol: string;
    flareToken: string;
  }>;
  const found = ports.find((p) => p.symbol.toLowerCase() === symbol.toLowerCase());
  if (found === undefined) throw new Error(`${symbol} is not in MINA_ASSET_PORTS`);
  return found.flareToken;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — source .env first`);
  return value;
}

/** Read the eight raw slots, which is the only honest view mid-migration. */
async function readState(address: PublicKey): Promise<Field[]> {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `{ account(publicKey: "${address.toBase58()}") { zkappState } }`,
    }),
  });
  const body = (await res.json()) as { data?: { account?: { zkappState?: string[] } } };
  const state = body.data?.account?.zkappState;
  if (state === undefined) throw new Error('could not read the account state');
  return state.map((s) => Field(s));
}

async function installKey(
  address: PublicKey,
  zkAppKey: PrivateKey,
  feePayerKey: PrivateKey,
  verificationKey: { data: string; hash: Field },
  label: string,
): Promise<void> {
  const feePayer = feePayerKey.toPublicKey();
  await fetchAccount({ publicKey: feePayer });
  await fetchAccount({ publicKey: address });

  const tx = await Mina.transaction({ sender: feePayer, fee: FEE }, async () => {
    AccountUpdate.createSigned(address).account.verificationKey.set(verificationKey);
  });
  const pending = await tx.sign([feePayerKey, zkAppKey]).send();
  console.log(`  ${label} -> ${pending.hash}`);
  await pending.wait();
}

// Mandatory, not a preference: AssetPort pulls in FdcLeaf, whose proving key
// overflows the wasm heap while being serialised. Without this the compile dies
// with `rust_oom` — and in a migration it dies *between* the state rewrite and
// the real key going back, leaving StateMigration installed on a live port.
setBackend('native');
await initializeBindings();

async function main() {
  const [what, symbol] = process.argv.slice(2);
  if (what !== 'bridge' && what !== 'port' && what !== 'repair-admin') {
    throw new Error('usage: migrateState.js <bridge|port|repair-admin> [symbol]');
  }

  Mina.setActiveInstance(Mina.Network(GRAPHQL));
  const feePayerKey = PrivateKey.fromBase58(required('MINA_DEVNET_PRIVATE_KEY'));
  const adminKey = feePayerKey;

  let address: PublicKey;
  let zkAppKey: PrivateKey;

  if (what === 'bridge') {
    address = PublicKey.fromBase58(required('MINA_BRIDGE_ACCOUNT'));
    zkAppKey = PrivateKey.fromBase58(required('BRIDGE_KEY'));
  } else {
    if (symbol === undefined) throw new Error('a port needs a symbol, e.g. BFXRP');
    address = PublicKey.fromBase58(required(`MINA_${symbol.toUpperCase()}_PORT`));
    zkAppKey = PrivateKey.fromBase58(required(`MINA_${symbol.toUpperCase()}_PORT_KEY`));
  }
  if (zkAppKey.toPublicKey().toBase58() !== address.toBase58()) {
    throw new Error('the private key does not belong to that account');
  }

  const before = await readState(address);
  console.log(`account : ${address.toBase58()}`);
  console.log('state before:');
  before.forEach((f, i) => console.log(`  [${i}] ${f.toString()}`));

  // The rearrangement. Written out slot by slot rather than computed, because
  // this is the step that is easy to get subtly wrong and impossible to check
  // afterwards from the values alone.
  let after: Field[];
  if (what === 'repair-admin') {
    // Only slot [7]. Everything else is already in its new place, so recomputing
    // the whole layout from a state that has already moved would be wrong.
    // The same fallback the prover uses to sign a rotation. They have to agree,
    // and hard-coding one variable here would silently commit to a key the
    // relayer never signs with.
    const key =
      process.env.MINA_LOCK_ADMIN_PRIVATE_KEY ??
      process.env.MINA_WITHDRAWAL_ATTESTOR_PRIVATE_KEY ??
      required('MINA_DEVNET_PRIVATE_KEY');
    const admin = PrivateKey.fromBase58(key).toPublicKey();
    console.log('admin  :', admin.toBase58());
    after = [...before.slice(0, 7), adminCommitment(admin)];
  } else if (what === 'bridge') {
    // was: policyRoot | flareBridge | flareState | processed | weight | admin.x | admin.isOdd | -
    // now: policyRoot | flareChain  | flareState | processed | weight | token   | admin.x     | admin.isOdd
    //
    // The two chain slots go back to zero: every asset folds into a freshly
    // deployed `TransferChain` whose head starts there, and the old per-rail
    // chain is abandoned. Anything it still owed must be released *before* this
    // runs — the burn already happened on Flare, and a reset cursor cannot
    // reach it.
    after = [
      before[0]!,
      Field(BigInt(required('FLARE_TRANSFER_CHAIN_ADDRESS'))),
      Field(0),
      Field(0),
      before[4]!,
      Field(BigInt(required('FLARE_FMINA_ADDRESS'))),
      before[5]!,
      before[6]!,
    ];
  } else {
    // was: policyRoot | lockState | processed | weight | mintAuth | vault      | admin.x    | admin.isOdd
    // now: policyRoot | lockState | processed | weight | asset    | mintAuth   | flareChain | adminHash
    //
    // Both chain slots reset, for the reason given above. The admin key becomes
    // a hash: a `PublicKey` costs two of the eight fields, and the eighth is
    // spent on `asset` — which is what separates this port's locks from the
    // other three now that they share a chain.
    after = [
      before[0]!,
      Field(0),
      Field(0),
      before[3]!,
      Field(BigInt(flareTokenOf(symbol!))),
      before[4]!,
      Field(BigInt(required('FLARE_TRANSFER_CHAIN_ADDRESS'))),
      // [6] and [7], not [5] and [6]: the old layout put the vault at [5], and
      // hashing that as `admin.x` produced a commitment to a key nobody holds —
      // which locks `setSigningPolicyRoot` out for good, and with it every
      // publication to the port. Run `repair-admin` on anything migrated before
      // this was fixed.
      adminCommitment(PublicKey.from({ x: before[6]!, isOdd: before[7]!.equals(Field(1)) })),
    ];
  }

  console.log('state after:');
  after.forEach((f, i) => console.log(`  [${i}] ${f.toString()}`));

  console.log('\ncompiling the migration circuit…');
  const migration = await StateMigration.compile();

  console.log('installing it…');
  await installKey(address, zkAppKey, feePayerKey, migration.verificationKey, 'migration key');

  console.log('rewriting state…');
  await fetchAccount({ publicKey: address });
  const contract = new StateMigration(address);
  const rewrite = await Mina.transaction(
    { sender: feePayerKey.toPublicKey(), fee: FEE },
    async () => {
      await contract.setAll(
        after[0]!, after[1]!, after[2]!, after[3]!,
        after[4]!, after[5]!, after[6]!, after[7]!,
      );
    },
  );
  await rewrite.prove();
  const rewritten = await rewrite.sign([feePayerKey, adminKey]).send();
  console.log(`  setAll -> ${rewritten.hash}`);
  await rewritten.wait();

  console.log('compiling the real circuit…');
  // Dependencies first: a contract's key depends on the keys of every proof it
  // verifies, so compiling out of order yields a different and wrong key.
  await RelayMessage.compile();
  await SigningPolicyFold.compile();
  await MerkleInclusion.compile();
  await FdcLeaf.compile();
  await FdcAttestation.compile();

  let real;
  if (what === 'bridge') {
    await TransferChain.compile();
    real = await MinaPortBridge.compile();
  } else {
    FungibleToken.AdminContract = AssetPort as never;
    await TransferChain.compile();
    real = await AssetPort.compile();
  }

  console.log('installing it…');
  await installKey(address, zkAppKey, feePayerKey, real.verificationKey, 'real key');

  const finalState = await readState(address);
  console.log('\nstate now:');
  finalState.forEach((f, i) => console.log(`  [${i}] ${f.toString()}`));
  console.log('vk hash :', real.verificationKey.hash.toString());
}

await main();
