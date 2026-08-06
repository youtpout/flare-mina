# Flare x Mina — Project Memory

## Product

**Flare x Mina.** Package and crate identifiers still use the `minaport` prefix
from the original working name; those are internal and unrelated to the product
name.

Flare x Mina brings native MINA liquidity to Flare, and gives Mina wallets authority
on Flare without an EVM key.

Two independent rails, deliberately decoupled so neither blocks the other:

1. **Bridge** — lock native MINA in a Mina zkApp, mint fully collateralized
   `FMINA` on Flare, swap it against Flare assets, burn it to withdraw.
2. **Authorization** — a Mina Schnorr signature, verified DIRECTLY in Solidity
   on Flare, authorises actions on Flare contracts. No proof, no relayer.

Target: Flare Summer Signal hackathon, **MVP due 14 August 2026**.
Bounty: *Interoperable Asset Products*.

## Hard constraint that shapes everything

A Mina key is a **Pallas** key. It cannot produce an ECDSA secp256k1 signature,
so it can never control an EOA on Flare. Any "Mina controls Flare" design must
therefore route through a contract. We never reuse the Mina private key as an
ECDSA key.

The usual answer is a proof. On Flare it is not needed: the Pallas base field is
a 255-bit prime, so it fits in one EVM word and `mulmod` handles it natively.

## Architecture

```
Mina                                  Flare (Coston2, chainId 114)
────                                  ───────────────────────────
zkApp escrow ──deposit batch──────────────► MinaPortBridge ──► FMINA ──► swaps
Mina wallet signature ─────────────────────► MinaAuthRegistry
                                             (direct Schnorr verify, ~809k gas)
```

### MVP: direct on-chain verification, no proof

**Decision: SP1 is OFF the MVP path.** A Mina Schnorr signature is verified
directly in Solidity for ~809k gas (under a cent on Flare). No prover, no
relayer, no trusted setup, no proving artifacts, no multi-minute wait.

This works because the Pallas base field is a 255-bit prime: it fits in one EVM
word, so `mulmod`/`addmod` handle it natively at 8 gas each. It is a Flare
answer, not a portable one — the same code on Ethereum would cost tens of
dollars, where Groth16 at ~200k gas wins.

`packages/prover` stays in the repo as roadmap: SP1 earns its place proving Mina
zkApp *state transitions* for a trust-minimised bridge, which curve arithmetic
on-chain cannot replace.

### Historical: the two proving routes considered

| Route | What SP1 verifies | Cost | Used for |
|-------|-------------------|------|----------|
| **A** | A full Pickles proof, via the existing `o1js-to-zkvm` universal verifier | Heavy (dominated by a 2^16 Vesta MSM) | The real bridge, post-hackathon |
| **B** | A Mina Schnorr signature directly, in Rust | **~2.0 M cycles**, measured | **Everything in the hackathon MVP** |

Neither is used for the hackathon MVP; direct verification replaced both.
Route B is implemented in `packages/prover` and kept for the bridge work.

### Measured cost (not estimated)

`minaport-host execute --batch N`:

| Batch | Total cycles | Per authorization |
|-------|--------------|-------------------|
| 1     | 3,214,892    | 3,214,892         |
| 4     | 9,322,399    | 2,330,599         |
| 16    | 33,322,147   | 2,082,634         |

Marginal cost **~2.0 M cycles/signature**, fixed guest overhead **~1.2 M cycles**.

**What batching does and does not buy.** Execution scales linearly — extra
signatures are never free. What is fixed is the Groth16 wrap, not the STARK.
Batching amortizes the wrap; core proving still grows with cycles, so the useful
batch size is on the order of tens, not hundreds. (An earlier draft of this file
claimed 1 and 200 signatures cost the same; the measurement disproved it.)

On-chain verification on Flare is ~250–300k gas and is independent of the Mina
signature scheme — the exotic Pallas curve is absorbed entirely off-chain.

## Repository layout

```
packages/
├── shared/            @minaport/shared — canonical encodings (TS)
│   ├── constants.ts        domain tags, decimals, chain ids, Pallas field order
│   ├── minaAddress.ts      base58check codec, bytes32 packing
│   ├── encoding.ts         deposit leaf / withdrawal / public values ABI
│   ├── merkle.ts           keccak sorted-pair tree
│   ├── batch.ts            batch assembly + claim bundles
│   ├── linkAccounts.ts     EIP-712 link payload + verification helpers
│   └── fixtures/           deterministic vectors shared with Rust and Solidity
├── mina-contracts/    o1js zkApp (escrow, deposit actions, withdrawal release)
├── flare-contracts/   Foundry: FMINA, MinaPortBridge, MinaAuthRegistry
└── prover/            Rust: Schnorr verifier, SP1 guest, host CLI
    ├── minaport-schnorr    no_std Pallas Schnorr verification
    ├── minaport-core       authorization struct, field + ABI encodings
    ├── minaport-guest      SP1 guest (batch verify)
    └── minaport-host       CLI: `execute` (cycles) / `prove` (Groth16)
```

## Consensus-critical encodings

These MUST match byte-for-byte across TypeScript, Rust and Solidity. Drift is
caught by `packages/shared/fixtures/deposit-batch.json`, which all three read.

- **Mina public key on EVM**: `x | isOdd << 255`. Bit-compatible with
  `ZekoAddress.sol` in the ethereum-settlement repo — deliberately, so both
  bridges agree. Validated against the Pallas field order on every ingress.
- **Mina base58 address**: 40 bytes, `cb 01 01 | x(LE,32) | isOdd | checksum(4)`.
  Note the little-endian `x` on the wire versus big-endian everywhere else.
  Verified against o1js reference vectors.
- **Deposit leaf**: `keccak256(abi.encode(domain, nonce, senderX, senderIsOdd,
  recipient, amount))` — six ABI words (192 bytes). Internal Merkle nodes hash
  64 bytes, so leaf and node digests live in disjoint preimage spaces.
- **Authorization field encoding**: 6 Pallas field elements. `actionHash` is
  split 128/128 across two elements because a 256-bit digest does not fit in one
  ~254-bit field without silent reduction.

## Measured gas (Foundry, optimizer_runs = 100000)

| Operation | Gas |
|-----------|-----|
| Full signature verification, 6-field message | 808,891 |
| `MinaAuthRegistry.consume` incl. storage write | 834,588 |
| Rejected early (wrong chain/target/nonce) | 6,488 |
| Poseidon permutation | 47,608 |
| Pallas scalar multiplication | 613,432 |
| `s*G + e*P` via Strauss-Shamir | 806,713 |

Flare block gas limit: 28,000,000. Base fee observed: 500 gwei.

### What produced the savings, in order of value

1. Round constants in bytecode, not a storage array — removes 165 cold SLOADs
2. Strauss-Shamir, one shared doubling chain for both scalars — −43% on curve work
3. `optimizer_runs` 200 -> 100,000 — −26% overall
4. Mixed addition against affine window tables
5. Comparing `R.x` projectively instead of a second inversion

### What did NOT work

- **Hand-written Yul was 1.83x slower** than the Solidity it replaced (92k vs
  50k per Poseidon permutation). With 10+ live values per round the binding
  constraint is stack scheduling, and the IR allocator beats hand assembly.
  Do not reach for Yul on this codebase without measuring first.
- **Computing the public key `y` on-chain.** `a^((P+1)/4)` needs `P = 3 (mod 4)`;
  Pallas has `P = 1 (mod 4)` with 2-adicity 32. `y` is a caller argument, pinned
  by the curve equation plus the parity bit.

## Mina network domains — important

`mina-signer` 4.1.0 hardcodes `'devnet'` in `signFields`/`verifyFields`
(mina-signer.js:120). `signMessage`, `signTransaction` and `signZkappCommand`
thread `this.network` through; the field path does not.

**Every field signature from standard tooling carries the devnet domain on every
network.** Do not rely on Mina network separation for replay protection. Chain
binding comes from the `chainId` field inside the signed message.

Both domains are implemented and positively tested anyway, since signatures from
other paths do carry the network.

## Key design decisions

### Decimals
FMINA has **9 decimals**, not 18. One nanomina locked on Mina equals one FMINA
base unit. The collateral invariant `totalSupply(FMINA) == escrowedNanomina` is
then an exact integer equality with no conversion or rounding anywhere.

### Merkle tree
Sorted-pair keccak (OpenZeppelin `MerkleProof` compatible), leaves padded to a
power of two with a fixed sentinel. Consequence: **the root commits to the SET
of leaves, not their order.** That is sufficient here — a deposit leaf carries
every field a claim needs and `claimedDeposits` is keyed by leaf digest, so leaf
position is never security-relevant. Do not reuse this tree where position
matters.

### Claiming is permissionless
`claimDeposit` mints to the recipient encoded in the leaf, so anyone may pay the
gas. Same for `submitDepositBatch`: the proof is the authorisation, which means
a censoring relayer can always be routed around.

### No `proof_valid` boolean in the guest
The guest panics on the first invalid signature, so a proof only exists for a
fully verified batch. A boolean would be a footgun for consumers who forget to
check it. (Same reasoning as `o1js-to-zkvm`.)

### What the proof does NOT say
It attests that the Mina key signed. It says nothing about whether the action is
currently appropriate. `chainId`, `target`, `expiry` and `nonce` are enforced
on-chain, not in the circuit, because they are properties of chain state.

## Reused from other local repos

- `ethereum-settlement/contracts/src/ZekoAddress.sol` → `MinaAddress.sol`
  (identical packing scheme, plus a `fromBytes32` ingress validator).
- `o1js-to-zkvm` → the fork `youtpout/proof-systems`, branch
  `migrate/openvm-2.1-rv64`, which carries the SP1 `sys_bigint` feature. Pinning
  the SAME branch keeps every proof-systems crate resolving to one copy; mixing
  sources yields two distinct `Fp` types and a wall of mismatch errors.
- `o1js-to-zkvm/crates/o1-verifier-host/build.rs` → the guest sub-build pattern
  (`sp1_build::build_program_with_args` with `features: ["sp1"]`).

## o1js gotchas found the hard way

- **`proofsEnabled: false` stubs nested proofs.** A contract-to-contract call
  never executes the callee's method, so a suite testing that `canMint` blocks
  unauthorised mints passes without ever running `canMint`. Any test whose
  subject is a cross-contract check MUST use `proofsEnabled: true` and compile.
- **State written by one account update is invisible to a later account update
  on the same zkApp in the same transaction.** Preconditions are evaluated
  against the state as of the transaction's start. Authorise-then-act flows on
  one contract need two transactions.
- **`FungibleToken.AdminContract`** is the standard's override point for a custom
  admin. Without setting it the token resolves the default `FungibleTokenAdmin`
  and every `canMint` fails for want of a prover — which a test expecting a
  rejection reports as a pass, for entirely the wrong reason.
- **`mina-fungible-token` 1.1.0 requires `canChangeVerificationKey`** on the
  admin; 1.0.0 did not.

## Toolchain gotchas

- **o1js decorators need `emitDecoratorMetadata`, which esbuild does not
  implement.** Vitest therefore transforms `packages/mina-contracts` with SWC
  (`unplugin-swc`), not esbuild.
- **o1js admin pattern**: `this.requireSignature()` conflicts with
  `editState: Permissions.proof()` — it changes the account update's
  authorisation kind from proof to signature. Use a separate signed
  `AccountUpdate.createSigned(admin)` instead, with admin fixed at deploy time.
- **Natspec**: a `@word` inside a Solidity doc comment is parsed as a doc tag.
  Never write a package name like `@scope/pkg` in Solidity comments.
- **arkworks version unity**: the whole prover workspace must be on ark 0.5,
  matching the proof-systems fork. Mixing 0.4 and 0.5 gives "multiple versions
  of crate ark_ff" trait-resolution failures.
- **`timeout(1)` does not exist on macOS.**
- Signature verification helpers must return `false` on malformed input rather
  than throwing — they run on relayer-facing data.

## Commands

```sh
pnpm install
pnpm --filter @minaport/shared test        # 32 tests
pnpm --filter @minaport/shared fixtures    # regenerate shared vectors
cd packages/flare-contracts && forge test  # 28 tests
cd packages/prover && cargo test           # 9 conformance tests vs o1js
cd packages/prover && cargo run --release -p minaport-host -- execute --batch 8
```

## Status

| Component | State |
|-----------|-------|
| `packages/shared` | Done, 32 tests passing |
| `minaport-schnorr` | Done, 9 tests passing against real o1js signatures |
| `minaport-core` | Done |
| `minaport-guest` / `minaport-host` | Written, first build in progress |
| `flare-contracts` bridge + token | Done, 28 tests passing |
| `MinaAuthRegistry.sol` | Written, tests pending |
| `mina-contracts` zkApp | Written, tests pending (admin pattern reworked) |
| Swap adapter + mock DEX | Not started |
| Frontend / relayer | Not started |
| Docs | In progress |

## Explicit MVP limitations

Stated here so they are never accidentally presented as solved:

- The Flare → Mina return path uses a **trusted attestor**, not FDC + Relay
  signature verification in Pickles. That is out of reach in the hackathon
  window and is on the roadmap.
- `MockSettlementVerifier` accepts any proof. It exists for frontend and test
  work and must never be deployed to a network holding value.
- Bridging Flare assets (FXRP, USD₮0, WETH) toward Mina depends on the trustless
  return path and is roadmap, not MVP.

## Conventions

- All code, comments and docs in **English**.
- **Comments: 3 lines max** per method and per contract/module summary. Facts
  worth keeping longer than a diff go here, not in a doc block.
- TypeScript strict mode; Rust with no `unsafe` unless documented.
- Never use floating-point arithmetic for token amounts.

## Measured costs

Mina circuit rows (65,536-row domain, so >21k forces recursion):

| | rows |
|---|---|
| Poseidon, 2 fields | 13 |
| Mina Schnorr verify | 349 |
| `WithdrawalChain.link` | 48 |
| policy membership, 128 leaves | 132 |
| `IndexedMerkleMap` h=21, get | 340 |
| `releaseWithdrawal` | 795 |
| `deposit` | 797 |
| `publishFlareActionState` | 1,009 |
| keccak256 over 64 B | 14,733 |
| keccak256 over 512 B | 59,675 |
| `SigningPolicyFold.single` (ECDSA) | 31,973 |

Proving on an idle M4 (wasm; native ~1.8x faster): compile 6-13s, one keccak
level 6s, a merge 8.6s, one ECDSA 9.4s, a release 6.4s.

Flare gas: Poseidon(2 fields) 41,894 · withdrawal chain link 166,694 ·
IndexedMerkleMap insert ~2.79M. Coston2 block limit is 28M.

## Flare protocol facts (verified on Coston2)

- Validator signatures live **only in `Relay.relay()` calldata** — never in
  storage, never in an event. Layout: `4 selector | 2 voters | 3 rewardEpoch |
  4 startRound | 2 threshold | 32 seed | voters*(20+2) | 38 message |
  2 sigCount | sigs*(1 v + 32 r + 32 s + 2 index)`.
- Signatures are over the **EIP-191 prefixed** digest,
  `hashMessage(keccak256(message))` — not `keccak256(message)`.
- `toSigningPolicyHash` is chained, not a flat keccak: hash the first 64 bytes,
  then fold in each following 32-byte word, last one zero-padded.
- FDC round trees use sorted pairs: `keccak256(abi.encode(sort([a,b])))`.
- Protocol 100 = FTSO, 200 = FDC. Voting rounds 90s. Reward epochs **6h on
  Coston2** (`rewardEpochDurationSeconds` = 21600), 3.5 days on mainnet — so the
  signing policy, and `signingPolicyRoot`, go stale four times a day on testnet.
- Coston2: 8 voters, total weight 65,534, threshold 32,767. A voter may have
  weight 0. The public RPC caps `getLogs` at **30 blocks**.
- The systems explorer's *validators* page lists node identities, not signing
  policy addresses. Only the latter appear in `Relay` calldata.
- Across an epoch boundary the signer **set and weights are unchanged** — only
  the order rotates, by a varying amount (observed 2, 6, 1, 0, 6, 1 over epochs
  5897-5903, ~42h). A rotation of 0 leaves the root identical. The root usually
  changes while nothing expensive does, and recovered keys stay valid: match
  voters to keys **by address**, never by index or epoch. Mainnet weights follow
  stake, so do not assume any of this is guaranteed by the protocol.
- FDC attests Flare itself (`testFLR` is a valid `EVMTransaction` source), and
  `provideInput: false` + one `logIndex` keeps the leaf small.

## Gotchas

- `tsx` does not emit decorator metadata, so o1js `@method` classes fail under
  it. Run such scripts through vitest.
- Loops with `Provable.if` in a ZkProgram can measure fine and still fail
  `compile()` with `length mismatch in Array.map2_exn`. Prefer merges.
- `Poseidon.hashWithPrefix(p, x)` is not `hash([p, ...x])`: the sponge has
  rate 2, so prepending absorbs the prefix with the first field.
- OZ 5.7 removed `ReentrancyGuardUpgradeable`; importing the base one is the
  documented migration.
- The zkApp's 8 state fields are raw — a verification-key upgrade does not
  migrate their meaning.
- An `AccountUpdate` on a Mina account that does not exist fails the whole
  transaction: included, rejected, nonce consumed. `send()` still resolves, so
  the sender sees success and the state simply never changes. Fund every key a
  method signs with before relying on it.
- `PoseidonPallas` and `MinaSchnorr` are `public` libraries, so they are
  deployed once and DELEGATECALLed rather than inlined. Every contract that
  imports them therefore has different bytecode than before that change, even
  with an unchanged source — `MinaAuthRegistry` went 14,861 -> 2,811 bytes.
  Verifying a contract deployed earlier means building from its deployment
  commit; `git log --follow` on the file, build each candidate in a throwaway
  worktree, and compare against `cast code`.
