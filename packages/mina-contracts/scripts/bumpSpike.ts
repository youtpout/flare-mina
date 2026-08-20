import {
  AccountUpdate,
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  SmartContract,
  State,
  addCachedAccount,
  fetchAccount,
  initializeBindings,
  method,
  setBackend,
  state,
} from 'o1js';

/**
 * Can several transactions that each move the same zkApp state land together?
 *
 * The bridge serialises every release and every mint because both read a cursor
 * as a precondition and write a new one — so the second, proved against the old
 * value, is rejected. Waiting for inclusion between each is what dominates the
 * latency now that the attestation proof is shared.
 *
 * This is that mechanism and nothing else: one field, read as a precondition,
 * incremented. If five bumps sent back to back all land, the same wave works
 * for releases, mints and publications. Better to find out on a counter.
 */
class Counter extends SmartContract {
  @state(Field) value = State<Field>();

  override init() {
    super.init();
    this.value.set(Field(0));
  }

  @method async bump(expected: Field) {
    this.value.getAndRequireEquals().assertEquals(expected);
    this.value.set(expected.add(1));
  }
}

const GRAPHQL =
  process.env.MINA_DEVNET_GRAPHQL ?? 'https://devnet-plain-1.gcp.o1test.net/graphql';
const FEE = 100_000_000;
const BUMPS = 5;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

setBackend('native');
await initializeBindings();
Mina.setActiveInstance(Mina.Network({ mina: GRAPHQL, archive: GRAPHQL }));

const feePayer = PrivateKey.fromBase58(required('MINA_DEVNET_PRIVATE_KEY'));
const sender = feePayer.toPublicKey();

const zkAppKey = process.env.SPIKE_KEY
  ? PrivateKey.fromBase58(process.env.SPIKE_KEY)
  : PrivateKey.random();
const zkAppAddress = zkAppKey.toPublicKey();
const zkApp = new Counter(zkAppAddress);

console.log('fee payer :', sender.toBase58());
console.log('zkApp     :', zkAppAddress.toBase58());
if (!process.env.SPIKE_KEY) console.log('SPIKE_KEY :', zkAppKey.toBase58());

console.log('\ncompiling…');
await Counter.compile();

await fetchAccount({ publicKey: sender });
const deployed = await fetchAccount({ publicKey: zkAppAddress });

if (deployed.account === undefined) {
  console.log('deploying…');
  const tx = await Mina.transaction({ sender, fee: FEE }, async () => {
    AccountUpdate.fundNewAccount(sender);
    await zkApp.deploy();
  });
  await tx.prove();
  const pending = await tx.sign([feePayer, zkAppKey]).send();
  console.log('  ->', pending.hash);

  // Not `wait()`: it gives up after a fixed number of polls and throws, which
  // says nothing about whether the transaction landed — it did, here, a minute
  // after the throw. The account appearing is the only signal that means
  // anything.
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000));
    const check = await fetchAccount({ publicKey: zkAppAddress });
    if (check.account !== undefined) break;
    process.stdout.write('.');
  }
  const there = await fetchAccount({ publicKey: zkAppAddress });
  if (there.account === undefined) throw new Error('the zkApp never appeared');
  console.log('\ndeployed');
}

await fetchAccount({ publicKey: sender });
await fetchAccount({ publicKey: zkAppAddress });

const start = Number(zkApp.value.get().toBigInt());
let nonce = Number(Mina.getAccount(sender).nonce.toBigint());
console.log(`\nvalue is ${start}, sending ${BUMPS} bumps from nonce ${nonce}\n`);

// The account as the network has it, captured once. Every bump is built against
// a copy of this with one slot moved forward.
const base = Mina.getAccount(zkAppAddress);

const hashes: string[] = [];
for (let i = 0; i < BUMPS; i++) {
  const expected = Field(start + i);

  const tx = await Mina.transaction({ sender, fee: FEE, nonce: nonce + i }, async () => {
    // The crux, and it has to be here rather than before the build.
    //
    // `Mina.transaction` runs this callback twice — once in `fetchMode: 'test'`
    // to discover which accounts it touches, then `Fetch.fetchMissingData()`,
    // then again in `'cached'`. That refetch overwrites the account cache with
    // what the network still reports, which is the state before the bumps we
    // already sent. Injecting outside the build gets wiped between the passes;
    // injecting here runs after it, so the second pass reads what we wrote and
    // the proof is built against the state the previous transaction leaves.
    //
    // Spread the whole account, never a partial one: `fillPartialAccount`
    // replaces anything left out with `type.empty()`, so an omitted `tokenId`
    // becomes Field(0) and the entry lands under a cache key nothing reads.
    const appState = [...base.zkapp!.appState];
    appState[0] = expected;
    addCachedAccount({ ...base, zkapp: { ...base.zkapp!, appState } }, GRAPHQL);

    await zkApp.bump(expected);
  });
  await tx.prove();
  const pending = await tx.sign([feePayer]).send();
  hashes.push(pending.hash);
  console.log(`  bump ${start + i} -> ${start + i + 1}  nonce ${nonce + i}  ${pending.hash}`);
}

console.log('\nall sent without waiting. Giving them three minutes to be included…');
await new Promise((r) => setTimeout(r, 180_000));

await fetchAccount({ publicKey: zkAppAddress });
const end = Number(zkApp.value.get().toBigInt());
console.log(`\nvalue is now ${end} (started at ${start})`);
console.log(end === start + BUMPS ? 'ALL LANDED' : `only ${end - start} of ${BUMPS} landed`);
