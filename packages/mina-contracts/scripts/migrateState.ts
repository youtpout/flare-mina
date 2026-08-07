import { AccountUpdate, Field, Mina, PrivateKey, PublicKey, fetchAccount } from 'o1js';
import { FungibleToken } from 'mina-fungible-token';
import { AssetPort } from '../src/AssetPort.js';
import { FdcAttestation, FdcLeaf } from '../src/FdcAttestation.js';
import { LockChain } from '../src/LockChain.js';
import { MerkleInclusion } from '../src/MerkleInclusion.js';
import { MinaPortBridge } from '../src/MinaPortBridge.js';
import { RelayMessage } from '../src/RelayMessage.js';
import { SigningPolicyFold } from '../src/SigningPolicyFold.js';
import { StateMigration } from '../src/StateMigration.js';
import { WithdrawalChain } from '../src/WithdrawalChain.js';

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

async function main() {
  const [what, symbol] = process.argv.slice(2);
  if (what !== 'bridge' && what !== 'port') {
    throw new Error('usage: migrateState.ts <bridge|port> [SYMBOL]');
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
  if (what === 'bridge') {
    // was: policyRoot | attestor.x | attestor.isOdd | flareState | processed | weight | admin.x | admin.isOdd
    // now: policyRoot | flareBridge | flareState    | processed  | weight    | admin.x | admin.isOdd | -
    after = [
      before[0]!,
      Field(BigInt(required('FLARE_BRIDGE_ADDRESS'))),
      before[3]!,
      before[4]!,
      before[5]!,
      before[6]!,
      before[7]!,
      Field(0),
    ];
  } else {
    // was: policyRoot | lockState | processed | weight | mintAuth | admin.x | admin.isOdd | -
    // now: policyRoot | lockState | processed | weight | mintAuth | vault   | admin.x     | admin.isOdd
    after = [
      before[0]!,
      before[1]!,
      before[2]!,
      before[3]!,
      before[4]!,
      Field(BigInt(required('FLARE_ASSET_VAULT_ADDRESS'))),
      before[5]!,
      before[6]!,
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
    await WithdrawalChain.compile();
    real = await MinaPortBridge.compile();
  } else {
    FungibleToken.AdminContract = AssetPort as never;
    await LockChain.compile();
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
