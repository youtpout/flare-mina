import { AccountUpdate, Mina, PrivateKey, PublicKey, fetchAccount, initializeBindings, setBackend } from 'o1js';
import { FungibleToken } from 'mina-fungible-token';
import { AssetPort } from '../src/AssetPort.js';
import { FdcAttestation, FdcLeaf } from '../src/FdcAttestation.js';
import { TransferChain } from '../src/TransferChain.js';
import { MerkleInclusion } from '../src/MerkleInclusion.js';
import { MinaPortBridge } from '../src/MinaPortBridge.js';
import { RelayMessage } from '../src/RelayMessage.js';
import { SigningPolicyFold } from '../src/SigningPolicyFold.js';

/**
 * Install a new verification key on a deployed zkApp.
 *
 * Every circuit change produces a new key, and until it is installed the
 * account still runs the old circuit — so a relayer on new code produces proofs
 * the chain rejects. The bridge is down in exactly that window, which is why
 * this exists as a script rather than a manual sequence.
 *
 * Authorised by the zkApp's own key, because `setVerificationKey` is
 * `signature()`. That key is the most dangerous one in the deployment: whoever
 * holds it can install a circuit that pays the escrow to itself. See
 * docs/threat-model.md.
 *
 * Usage, from the repository root:
 *   set -a && . ./.env && set +a
 *   pnpm --filter @minaport/mina-contracts exec node dist/scripts/upgrade.js bridge
 *   pnpm --filter @minaport/mina-contracts exec node dist/scripts/upgrade.js port bFXRP
 *
 * Run from `dist`, not through tsx: tsx does not emit decorator metadata, and
 * every `@method` class fails to load without it.
 */

const GRAPHQL =
  process.env.MINA_DEVNET_GRAPHQL ?? 'https://api.minascan.io/node/devnet/v1/graphql';
const FEE = 200_000_000; // 0.2 MINA

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — source .env first`);
  return value;
}

// Mandatory, not a preference: AssetPort pulls in FdcLeaf, whose proving key
// overflows the wasm heap while being serialised. Without this the compile dies
// with `rust_oom` — and in a migration it dies *between* the state rewrite and
// the real key going back, leaving StateMigration installed on a live port.
setBackend('native');
await initializeBindings();

async function main() {
  const [what, symbol] = process.argv.slice(2);
  if (what !== 'bridge' && what !== 'port') {
    throw new Error('usage: upgrade.ts <bridge|port> [SYMBOL]');
  }

  Mina.setActiveInstance(Mina.Network(GRAPHQL));
  const feePayerKey = PrivateKey.fromBase58(required('MINA_DEVNET_PRIVATE_KEY'));
  const feePayer = feePayerKey.toPublicKey();

  // Compile the dependencies first: a contract's key depends on the
  // verification keys of every proof it verifies, so compiling out of order
  // yields a different — and wrong — key.
  console.log('compiling…');
  let verificationKey;
  let address: PublicKey;
  let zkAppKey: PrivateKey;

  if (what === 'bridge') {
    await TransferChain.compile();
    await RelayMessage.compile();
    await SigningPolicyFold.compile();
    await MerkleInclusion.compile();
    await FdcLeaf.compile();
    await FdcAttestation.compile();
    ({ verificationKey } = await MinaPortBridge.compile());
    address = PublicKey.fromBase58(required('MINA_BRIDGE_ACCOUNT'));
    zkAppKey = PrivateKey.fromBase58(required('BRIDGE_KEY'));
  } else {
    if (symbol === undefined) throw new Error('a port needs a symbol, e.g. bFXRP');
    const upper = symbol.toUpperCase();
    FungibleToken.AdminContract = AssetPort as never;
    await TransferChain.compile();
    await RelayMessage.compile();
    await SigningPolicyFold.compile();
    await MerkleInclusion.compile();
    await FdcLeaf.compile();
    await FdcAttestation.compile();
    ({ verificationKey } = await AssetPort.compile());
    address = PublicKey.fromBase58(required(`MINA_${upper}_PORT`));
    zkAppKey = PrivateKey.fromBase58(required(`MINA_${upper}_PORT_KEY`));
  }

  if (zkAppKey.toPublicKey().toBase58() !== address.toBase58()) {
    // A mismatched pair produces a transaction that is included and rejected,
    // which costs a nonce and looks like success.
    throw new Error('the private key does not belong to that account');
  }

  console.log('account :', address.toBase58());
  console.log('new vk  :', verificationKey.hash.toString());

  await fetchAccount({ publicKey: feePayer });
  await fetchAccount({ publicKey: address });

  const tx = await Mina.transaction({ sender: feePayer, fee: FEE }, async () => {
    const update = AccountUpdate.createSigned(address);
    update.account.verificationKey.set(verificationKey);
  });

  const pending = await tx.sign([feePayerKey, zkAppKey]).send();
  console.log('tx hash :', pending.hash);
  console.log('explorer: https://minascan.io/devnet/tx/' + pending.hash);

  // Waited on: the next transaction against this account has to be proved
  // against the new circuit, and sending it early wastes a proof.
  console.log('waiting for inclusion…');
  await pending.wait();
  console.log('installed.');
}

await main();
