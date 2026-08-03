import { AccountUpdate, Mina, PrivateKey, PublicKey, fetchAccount } from 'o1js';
import { MinaPortBridge } from '../src/MinaPortBridge.js';

/**
 * Deploy the escrow zkApp to Mina devnet.
 *
 * The account this creates is where deposits land. Funds move in and out only
 * through proved methods — `receive` and `send` are both `Permissions.proof()`
 * — which is the whole reason to use a zkApp here rather than a plain account:
 * a key holding the escrow could rug it, and this cannot.
 *
 * `receive` is deliberately as strict as `send`. An ordinary payment would
 * credit the balance without running `deposit`, leaving `lockedNanomina`
 * behind and the funds unreleasable forever. Refusing the payment is the only
 * outcome that leaves the sender's MINA usable.
 *
 * Usage, from the repository root:
 *   set -a && . ./.env && set +a
 *   pnpm --filter @minaport/mina-contracts exec tsx scripts/deployBridge.ts
 */

const GRAPHQL = process.env.MINA_DEVNET_GRAPHQL ?? 'https://api.minascan.io/node/devnet/v1/graphql';
const FEE = 200_000_000; // 0.2 MINA

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — source .env first`);
  return value;
}

async function main() {
  const network = Mina.Network(GRAPHQL);
  Mina.setActiveInstance(network);

  const deployerKey = PrivateKey.fromBase58(required('MINA_DEVNET_PRIVATE_KEY'));
  const deployer = deployerKey.toPublicKey();

  // The zkApp gets its own key. Losing it costs the ability to rotate the
  // attestor and nothing else — it cannot move the escrow.
  const zkAppKey = PrivateKey.random();
  const zkAppAddress = zkAppKey.toPublicKey();

  // Until the Flare-side proof exists, one key attests withdrawals. Keeping it
  // distinct from the deployer means the deployer alone cannot release funds.
  const attestor = PublicKey.fromBase58(
    process.env.MINA_WITHDRAWAL_ATTESTOR ?? deployer.toBase58(),
  );

  console.log('deployer :', deployer.toBase58());
  console.log('zkApp    :', zkAppAddress.toBase58());
  console.log('attestor :', attestor.toBase58());
  console.log('\nzkApp private key (store it, it is not recoverable):');
  console.log(zkAppKey.toBase58(), '\n');

  await fetchAccount({ publicKey: deployer });

  console.log('compiling…');
  const { verificationKey } = await MinaPortBridge.compile();
  console.log('verification key hash:', verificationKey.hash.toString());

  const bridge = new MinaPortBridge(zkAppAddress);

  console.log('building deploy transaction…');
  const tx = await Mina.transaction({ sender: deployer, fee: FEE }, async () => {
    AccountUpdate.fundNewAccount(deployer);
    await bridge.deploy({ admin: deployer, withdrawalAttestor: attestor });
  });

  console.log('proving…');
  await tx.prove();

  console.log('sending…');
  const pending = await tx.sign([deployerKey, zkAppKey]).send();

  console.log('tx hash :', pending.hash);
  console.log('explorer: https://minascan.io/devnet/tx/' + pending.hash);
  console.log('\nWaiting for inclusion — this takes a few minutes on devnet.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
