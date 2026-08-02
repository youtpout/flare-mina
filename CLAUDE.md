# MinaPort — Project Memory

## Product

MinaPort brings native MINA liquidity to Flare, and gives Mina wallets authority
on Flare without an EVM key.

Two independent rails, deliberately decoupled so neither blocks the other:

1. **Bridge** — lock native MINA in a Mina zkApp, mint fully collateralized
   `wMINA` on Flare, swap it against Flare assets, burn it to withdraw.
2. **Authorization** — a Mina Schnorr signature, verified inside an SP1 guest and
   settled on Flare as a Groth16 proof, authorises actions on Flare contracts.

Target: Flare Summer Signal hackathon, **MVP due 14 August 2026**.
Bounty: *Interoperable Asset Products*.

## Hard constraint that shapes everything

A Mina key is a **Pallas** key. It cannot produce an ECDSA secp256k1 signature,
so it can never control an EOA on Flare. Any "Mina controls Flare" design must
therefore route through a contract plus a proof. We never reuse the Mina private
key as an ECDSA key.

## Architecture

```
Mina                                  Flare (Coston2, chainId 114)
────                                  ───────────────────────────
zkApp escrow ──deposit actions──┐
                                ├──► SP1 guest ──Groth16──► MinaPortBridge ──► wMINA
Snap Schnorr signature ─────────┘                           MinaAuthRegistry
```

### Two proving routes — pick per use case

| Route | What SP1 verifies | Cost | Used for |
|-------|-------------------|------|----------|
| **A** | A full Pickles proof, via the existing `o1js-to-zkvm` universal verifier | Heavy (dominated by a 2^16 Vesta MSM) | The real bridge, post-hackathon |
| **B** | A Mina Schnorr signature directly, in Rust | ~1–3 M cycles | **Everything in the hackathon MVP** |

Route A is NOT used for the hackathon. Route B is implemented in
`packages/prover`.

**The Groth16 wrap cost is fixed and dominates.** Verifying 1 or 200 signatures
in one guest run costs nearly the same wall clock. Therefore: always batch.
On-chain verification on Flare is ~250–300k gas and is independent of the Mina
signature scheme — the exotic curve is absorbed entirely off-chain.

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
├── flare-contracts/   Foundry: WrappedMINA, MinaPortBridge, MinaAuthRegistry
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

## Key design decisions

### Decimals
wMINA has **9 decimals**, not 18. One nanomina locked on Mina equals one wMINA
base unit. The collateral invariant `totalSupply(wMINA) == escrowedNanomina` is
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
- TypeScript strict mode; Rust with no `unsafe` unless documented.
- Never use floating-point arithmetic for token amounts.
