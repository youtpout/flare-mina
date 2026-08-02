# Flare x Mina

**Native MINA liquidity on Flare, and Mina wallets with authority on Flare.**

> Mina has assets but little DeFi. Flare has DeFi but no MINA. Flare x Mina
> bridges native MINA into a fully collateralized FMINA on Flare and lets a Mina
> wallet authorize Flare transactions directly — so Mina users trade on Flare's
> liquidity without ever needing an EVM key.

Two problems, one answer:

- **Mina lacks liquidity.** Flare has assets — FXRP, USD₮0, WETH — and a working
  DeFi ecosystem. Flare x Mina brings MINA there as a fully collateralized ERC-20.
- **DeFi on Mina is thin and proving is expensive.** So instead of building DeFi
  on Mina, let a Mina wallet act on Flare's DeFi directly, and bridge back when
  it wants to.

## The constraint everything follows from

A Mina key is a **Pallas** key. It cannot produce an ECDSA secp256k1 signature,
so it can never control an EOA on an EVM chain. Authority has to flow through a
contract, and we never reuse the Mina private key as an ECDSA key.

The usual answer is a zero-knowledge proof. **We don't need one.**

The Pallas base field is a 255-bit prime. It fits in a single EVM word, so
`mulmod` and `addmod` operate on it natively at 8 gas each — no limb
decomposition, no bigint library. A Mina Schnorr signature can therefore be
verified *directly in Solidity*:

```
809,000 gas  ≈  0.40 FLR  ≈  under one cent on Flare
```

No prover. No relayer. No trusted setup. No proving artifacts. The user signs in
their Mina wallet, the frontend submits the signature, the contract verifies it.

This is a **Flare** answer rather than a general one, and deliberately so. The
identical code on Ethereum mainnet would cost tens of dollars per verification,
where a Groth16 proof at ~200k gas wins instead. Flare's cheap gas is what makes
the simple design the right one.

## Two rails

```
Mina                                     Flare (Coston2)
────                                     ───────────────
zkApp escrow ───deposit batch───────────► MinaPortBridge ──► FMINA ──► swaps
Mina wallet signature ──────────────────► MinaAuthRegistry
```

**1. Bridge.** Lock native MINA in a Mina zkApp; recipients claim `FMINA` on
Flare against a Merkle proof. Burning `FMINA` emits a canonical `WithdrawToMina`
event that releases the escrow.

**2. Authorization.** A Mina Schnorr signature, verified on-chain, authorises
actions on Flare contracts — binding an EVM controller, approving a swap,
anything. The `actionHash` is opaque to the registry, so one verifier serves
every use case.

The two rails are independent on purpose: neither blocks the other.

## Measured cost

Everything below is measured with Foundry, not estimated.

| Operation | Gas |
|-----------|-----|
| `MinaAccount.execute` — a Mina key moves ERC-20 on Flare | **850,363** |
| Same, against forked Coston2 state | **865,845** (3% of a block, 0.433 FLR) |
| Full signature verification, 6-field message | **808,891** |
| `MinaAuthRegistry.consume`, incl. storage write | **834,588** |
| Rejected early (wrong chain / target / nonce) | **6,488** |
| Poseidon permutation | 47,608 |
| Pallas scalar multiplication | 613,432 |
| `s·G + e·P` via Strauss-Shamir | 806,713 |

Flare's block gas limit is 28,000,000, so a verification is about 3% of a block.

Cheap checks run before the expensive one, so an invalid authorization costs
0.8% of a valid one and cannot be used to grief the chain.

### How it got there

The reference implementation this builds on
([youtpout/pallas_curve_verifier](https://github.com/youtpout/pallas_curve_verifier))
reports 1.6M gas for a two-field message and 2.4M for nineteen, which
interpolates to roughly 1.79M at six fields. The path down to 809k, in order of
what each was worth:

| Change | Effect |
|--------|--------|
| Round constants in bytecode, not a storage array | removes 165 cold SLOADs (~346k) |
| Strauss-Shamir: one shared doubling chain for both scalars | −43% on the curve work |
| `optimizer_runs` 200 → 100,000 | −26% overall |
| Mixed addition against affine window tables | included above |
| Comparing `R.x` projectively instead of inverting twice | one modexp saved |

Two things did **not** work, and are worth recording:

- **Hand-written Yul was 1.83x slower** than the Solidity it replaced (92k vs
  50k per Poseidon permutation). With ten-plus live values per round the binding
  constraint is stack scheduling, and the IR pipeline's allocator does that
  better than hand-written assembly. The wins here came from algorithm choice,
  data placement and compiler configuration — not from lowering the code.
- **Computing the public key's `y` on-chain.** The cheap `a^((P+1)/4)`
  square-root identity needs `P ≡ 3 (mod 4)`, and Pallas has `P ≡ 1 (mod 4)`
  with 2-adicity 32. `y` is supplied by the caller instead and pinned by the
  curve equation plus the parity bit — two mulmods rather than a Tonelli-Shanks
  loop, and no trust given away.

## No EVM key required

A Mina key has a Flare address before anything is deployed:

```
address = CREATE2(minaPublicKey)
```

`MinaAccount` holds tokens and executes arbitrary calls when presented with a
Schnorr signature from the one Mina key that owns it. **Anyone** may submit the
transaction — target, value and calldata are all committed to by the signed
`actionHash`, so the submitter cannot redirect anything and gains nothing by
trying. One honest submitter is enough, and there is no privileged relayer.

What the owner still needs is someone to pay gas. Reimbursing the submitter out
of the account's own FMINA balance — which removes the last reason to hold an
EVM account at all — is the next step and deliberately not in this version.

## Layout

```
packages/
├── shared/            canonical encodings shared by TS, Rust and Solidity
├── mina-contracts/    o1js zkApp: escrow, deposit actions, withdrawal release
├── flare-contracts/   Foundry: Pallas, Poseidon, MinaSchnorr, FMINA, bridge
└── prover/            Rust: SP1 pipeline — roadmap, not on the MVP path
```

### Consensus-critical encodings

Any digest below must match byte-for-byte across all three languages.
`packages/shared/fixtures/deposit-batch.json` is the shared vector set, read by
the TypeScript, Rust and Solidity suites — drift fails a test rather than
silently stranding funds.

| Structure | Encoding |
|-----------|----------|
| Mina key on EVM | `x \| isOdd << 255`, validated against the Pallas field order |
| Mina base58 address | `cb 01 01 \| x(LE,32) \| isOdd \| checksum(4)` — 40 bytes |
| Deposit leaf | `keccak256(abi.encode(domain, nonce, senderX, senderIsOdd, recipient, amount))` |
| Authorization | 6 Pallas field elements; `actionHash` split 128/128 |

`FMINA` has **9 decimals**, matching MINA's nanomina base unit exactly, so the
collateral invariant `totalSupply(FMINA) == escrowedNanomina` is an integer
equality with no conversion or rounding.

## A note on Mina network domains

Both Mina signature domains are implemented and positively tested. But
`mina-signer` 4.1.0 hardcodes the network in its field-signing path:

```js
signFields(fields, privateKey) {
    let signature = sign({ fields }, privateKey_, 'devnet');   // network ignored
```

`signMessage`, `signTransaction` and `signZkappCommand` all thread the
configured network through; `signFields` and `verifyFields` do not. **Every
field signature from the standard client therefore carries the devnet domain, on
every network**, and Mina's network separation is simply absent from this path.

Flare x Mina does not rely on it. An authorization is bound to its chain by the
`chainId` field inside the signed message, which is what `test_rejectsWrongChain`
covers.

## Setup

```sh
pnpm install
cd packages/flare-contracts && forge install
```

Requires Node ≥ 20, [pnpm](https://pnpm.io) and [Foundry](https://getfoundry.sh).
The SP1 toolchain is only needed for `packages/prover`, which is not on the MVP
path.

## Test

```sh
pnpm --filter @minaport/shared test          # canonical encodings
cd packages/flare-contracts && forge test    # curve, hash, signature, account, bridge

# Against live Coston2 state
COSTON2_RPC_URL=https://coston2-api.flare.network/ext/C/rpc \
  forge test --match-contract Coston2Fork -vv
cd packages/prover && cargo test             # Schnorr vs real Mina signatures
```

Signature tests use vectors produced by o1js `Signature.create` and by
`mina-signer`, so the implementations are pinned to the reference rather than to
themselves.

## Deploy

```sh
export COSTON2_RPC_URL=https://coston2-api.flare.network/ext/C/rpc
export PRIVATE_KEY=0x...        # funded from https://faucet.flare.network
forge script script/DeployAuth.s.sol --rpc-url $COSTON2_RPC_URL --broadcast
```

Two contracts, no constructor secrets, no owner, no upgrade path. Neither holds
funds and neither has an admin, so there is nothing to configure afterwards and
nothing to trust.

## Status

| Component | State |
|-----------|-------|
| `Pallas`, `PoseidonPallas`, `MinaSchnorr` | Working, 33 tests |
| `MinaAuthRegistry` | Working end to end, 12 tests |
| `MinaAccount` + factory | Working, 11 tests, signatures via FFI at run time |
| Coston2 fork test | Passing against live chain state |
| `FMINA`, `MinaPortBridge` | Working, 28 tests |
| `packages/shared` | 32 tests |
| `minaport-schnorr` (Rust) | 9 tests against real Mina signatures |
| `mina-contracts` zkApp | Written, tests pending |
| Swap adapter, frontend | Not started |

## Known limitations

Stated plainly so they are never mistaken for solved problems:

- **The Flare → Mina return path uses a trusted attestor**, not FDC + Relay
  signing-policy verification. Full trust-minimisation of the return path is out
  of reach in the hackathon window.
- **`MockSettlementVerifier` accepts any proof.** It exists so the bridge tests
  can exercise the deposit flow, and must never be deployed to a network holding
  value.
- **Bridging Flare assets toward Mina** (FXRP, USD₮0, WETH) depends on the
  trustless return path, and is roadmap rather than MVP.

## Roadmap: where SP1 earns its place

`packages/prover` contains a working SP1 guest that verifies Mina Schnorr
signatures, measured at **~2.0M cycles** marginal per signature with ~1.2M fixed
overhead, and a host CLI that produces real proofs (core proof generated and
verified in 1m43s on a laptop).

It is deliberately **not** on the MVP path, because on Flare direct verification
is cheaper in every dimension that matters: no relayer, no proving artifacts, no
multi-minute wait, no trusted setup.

Where it does earn its place is a **fully decentralized, trust-minimised
bridge** — proving Mina zkApp *state transitions* rather than individual
signatures, which no amount of on-chain curve arithmetic can replace. That work
also has a head start: the
[o1js-to-zkvm](https://github.com/youtpout) universal Pickles verifier already
settles any o1js proof through a single Solidity deployment.

Also on the roadmap: batching. The Groth16 wrap is a fixed cost, so amortising
it across many authorizations is what makes proofs competitive again — useful on
chains where gas, not proving, is the binding constraint.

## Licence

MIT
