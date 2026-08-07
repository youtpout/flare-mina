import { AccountUpdate, Field, Mina, PrivateKey, PublicKey, UInt64, fetchAccount } from 'o1js';
import { MinaPortBridge } from '../src/MinaPortBridge.js';
import { FdcAttestation, FdcLeaf } from '../src/FdcAttestation.js';
import { MerkleInclusion } from '../src/MerkleInclusion.js';
import { RelayMessage } from '../src/RelayMessage.js';
import { SigningPolicyFold } from '../src/SigningPolicyFold.js';
import { TransferChain } from '../src/TransferChain.js';

/**
 * Deploy the escrow zkApp to Mina devnet.
 *
 * The account this creates is where deposits land. Funds move in and out only
 * through proved methods — `receive` and `send` are both `Permissions.proof()`
 * — which is the whole reason to use a zkApp here rather than a plain account:
 * a key holding the escrow could rug it, and this cannot.
 *
 * `receive` is deliberately as strict as `send`. An ordinary payment would
 * credit the balance without ever dispatching an action, so nothing on Flare
 * could claim it. Refusing the payment is the only outcome that leaves the
 * sender's MINA usable — and it is also what makes the account balance the
 * escrowed total, so the contract needs no accounting of its own.
 *
 * Usage, from the repository root:
 *   set -a && . ./.env && set +a
 *   pnpm --filter @minaport/mina-contracts exec tsx scripts/deployBridge.ts
 *
 * `MINA_SIGNING_POLICY_ROOT` comes from `scripts/fetchPolicyTree.ts`. Without
 * it no signing-policy proof can ever be accepted, so it is required rather
 * than defaulted.
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

  // The zkApp gets its own key. It authorises verification-key upgrades and
  // nothing else — it cannot move the escrow.
  const zkAppKey = PrivateKey.random();
  const zkAppAddress = zkAppKey.toPublicKey();

  // The Flare `TransferChain` whose events this escrow accepts, and FMINA, the
  // one asset on it that belongs to this rail. Both pinned in state: an
  // attestation proves an event happened, not that it was ours.
  const flareChain = required('FLARE_TRANSFER_CHAIN_ADDRESS');
  const token = required('FLARE_FMINA_ADDRESS');

  const signingPolicyRoot = Field(required('MINA_SIGNING_POLICY_ROOT'));
  // Coston2's real threshold is 32,767 of 65,534. A demo can require less, but
  // the number has to be a deliberate choice rather than an omission.
  const requiredWeight = UInt64.from(BigInt(process.env.MINA_REQUIRED_WEIGHT ?? '32767'));

  console.log('deployer :', deployer.toBase58());
  console.log('zkApp    :', zkAppAddress.toBase58());
  console.log('chain    :', flareChain);
  console.log('token    :', token);
  console.log('policy   :', signingPolicyRoot.toString());
  console.log('weight   :', requiredWeight.toString());
  console.log('\nzkApp private key (store it, it is not recoverable):');
  console.log(zkAppKey.toBase58(), '\n');

  await fetchAccount({ publicKey: deployer });

  console.log('compiling…');
  // The contract verifies proofs from both, so their keys must exist first.
  await TransferChain.compile();
  await RelayMessage.compile();
  await SigningPolicyFold.compile();
  await MerkleInclusion.compile();
  await FdcLeaf.compile();
  await FdcAttestation.compile();
  const { verificationKey } = await MinaPortBridge.compile();
  console.log('verification key hash:', verificationKey.hash.toString());

  const bridge = new MinaPortBridge(zkAppAddress);

  console.log('building deploy transaction…');
  const tx = await Mina.transaction({ sender: deployer, fee: FEE }, async () => {
    AccountUpdate.fundNewAccount(deployer);
    await bridge.deploy({
      admin: deployer,
      flareChain: Field(BigInt(flareChain)),
      token: Field(BigInt(token)),
      signingPolicyRoot,
      requiredWeight,
    });
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
