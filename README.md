# Flare x Mina

**Native MINA liquidity on Flare, and Mina wallets with authority on Flare.**

> Mina has assets but little DeFi. Flare has DeFi but no MINA. Flare x Mina
> bridges native MINA into a fully collateralized wMINA on Flare and lets a Mina
> wallet authorize Flare transactions directly — so Mina users trade on Flare's
> liquidity without ever needing an EVM key.

Flare x Mina solves two problems at once:

- **Mina lacks liquidity.** Flare has assets — FXRP, USD₮0, WETH — and a working
  DeFi ecosystem. Flare x Mina brings MINA there as a fully collateralized ERC-20.
- **DeFi on Mina is thin, and proving is expensive.** So instead of building DeFi
  on Mina, let a Mina wallet act on Flare's DeFi directly, and bridge back when
  it wants to.

> A Mina key is a **Pallas** key. It cannot produce an ECDSA secp256k1 signature,
> so it can never control an EOA on an EVM chain. Everything below follows from
> that constraint: authority flows through a contract plus a proof, never through
> a reused private key.

## Two rails

```
Mina                                     Flare (Coston2)
────                                     ───────────────
zkApp escrow ───deposit actions───┐
                                  ├──► SP1 guest ──Groth16──► MinaPortBridge ──► wMINA
Snap Schnorr signature ───────────┘                           MinaAuthRegistry
```

**1. Bridge.** Lock native MINA in a Mina zkApp; a proof of the zkApp's action
state settles on Flare; recipients claim `wMINA` with a Merkle proof. Burning
`wMINA` emits a canonical `WithdrawToMina` event that releases the escrow.

**2. Authorization.** A Mina Schnorr signature is verified inside an SP1 guest and
settled on Flare as a Groth16 proof, letting a Mina key authorise actions on
Flare contracts — binding an EVM controller, authorising a swap, anything.

The two rails are independent on purpose: neither blocks the other.

## Why swaps do not need proofs

Once a user holds `wMINA`, swapping is an ordinary MetaMask transaction against
Flare liquidity. No proof is generated per swap.

That is a deliberate consequence of where the cost sits. A Mina signature costs
**~2.0M SP1 cycles** to verify — measured, not estimated (see below). That is
cheap in absolute terms but it is not free, and the Groth16 wrap on top is a
fixed cost of its own. Paying both on every swap would be absurd. So:

- **Prove once** to establish authority, then transact freely with an ordinary
  EVM key.
- **Batch** authorizations for users who genuinely have no EVM key.

On-chain verification on Flare is ~250–300k gas and is **independent of Mina's
signature scheme** — the exotic Pallas curve is absorbed entirely off-chain.

### Measured cost

| Batch | Total cycles | Per authorization |
|-------|--------------|-------------------|
| 1     | 3,214,892    | 3,214,892         |
| 2     | 5,267,124    | 2,633,562         |
| 4     | 9,322,399    | 2,330,599         |
| 8     | 17,302,166   | 2,162,770         |
| 16    | 33,322,147   | 2,082,634         |

Marginal cost is **~2.0M cycles per additional signature**, on top of **~1.2M
cycles** of fixed guest overhead. Pasta field arithmetic routes through SP1's
`sys_bigint` precompile, which is what keeps a 255-bit scalar multiplication
affordable.

**What batching does and does not buy.** Execution scales linearly, so extra
signatures are never free. What is fixed is the Groth16 wrap, not the STARK.
Batching amortizes the wrap; core proving still grows with cycles. The useful
batch size is bounded by where core proving time meets wrap time — on the order
of tens of signatures, not hundreds.

## Layout

```
packages/
├── shared/            canonical encodings shared by TS, Rust and Solidity
├── mina-contracts/    o1js zkApp: escrow, deposit actions, withdrawal release
├── flare-contracts/   Foundry: WrappedMINA, MinaPortBridge, MinaAuthRegistry
└── prover/            Rust: Pallas Schnorr verifier, SP1 guest, host CLI
```

### Consensus-critical encodings

Any digest below must match byte-for-byte across all three languages.
`packages/shared/fixtures/deposit-batch.json` is the shared vector set, read by
the TypeScript, Rust and Solidity test suites — drift fails a test rather than
silently stranding funds.

| Structure | Encoding |
|-----------|----------|
| Mina key on EVM | `x \| isOdd << 255`, validated against the Pallas field order |
| Mina base58 address | `cb 01 01 \| x(LE,32) \| isOdd \| checksum(4)` — 40 bytes |
| Deposit leaf | `keccak256(abi.encode(domain, nonce, senderX, senderIsOdd, recipient, amount))` |
| Authorization | 6 Pallas field elements; `actionHash` split 128/128 |

`wMINA` has **9 decimals**, matching MINA's nanomina base unit exactly, so the
collateral invariant `totalSupply(wMINA) == escrowedNanomina` is an integer
equality with no conversion or rounding.

## Setup

```sh
pnpm install
```

Requires Node ≥ 20, [pnpm](https://pnpm.io), [Foundry](https://getfoundry.sh),
and the [SP1 toolchain](https://docs.succinct.xyz) for the prover.

```sh
cd packages/flare-contracts && forge install
```

## Test

```sh
pnpm --filter @minaport/shared test          # canonical encodings
cd packages/flare-contracts && forge test    # bridge, token, registry
cd packages/prover && cargo test             # Schnorr vs real o1js signatures
```

The Rust suite verifies signatures produced by o1js `Signature.create`, so the
Rust verifier is pinned to the reference implementation rather than to itself.

## Measure proving cost

```sh
cd packages/prover
cargo run --release -p minaport-host -- execute --batch 1
cargo run --release -p minaport-host -- execute --batch 16
```

`execute` runs the guest in SP1's emulator and reports the instruction count and
cycles per authorization. Comparing `--batch 1` against `--batch 16` shows the
marginal cost of an extra authorization against the fixed overhead.

## Generate a proof

```sh
cargo run --release -p minaport-host -- prove --batch 8
```

Prints the program verification key, the ABI-encoded public values, and the
Groth16 proof bytes — the three inputs `MinaAuthRegistry.consume` expects.

## Status

| Component | State |
|-----------|-------|
| `packages/shared` | 32 tests passing |
| `minaport-schnorr` | 9 tests passing against real o1js signatures |
| `flare-contracts` (token, bridge) | 28 tests passing |
| `MinaAuthRegistry.sol` | Written, tests pending |
| `minaport-guest` / `minaport-host` | Builds and executes; cost measured |
| `mina-contracts` zkApp | Written, tests pending |
| Swap adapter, frontend, relayer | Not started |

## Known limitations

Stated plainly so they are never mistaken for solved problems:

- **The Flare → Mina return path uses a trusted attestor**, not FDC + Relay
  signing-policy verification inside Pickles. Full trust-minimisation of the
  return path is out of reach in the hackathon window and is on the roadmap.
- **`MockSettlementVerifier` accepts any proof.** It exists so the frontend and
  the test suite can exercise the full flow before the SP1 pipeline is wired in.
  It must never be deployed to a network holding value.
- **Bridging Flare assets toward Mina** (FXRP, USD₮0, WETH) depends on the
  trustless return path, and is roadmap rather than MVP.
- The hackathon MVP verifies **Mina signatures** in SP1, not full Pickles proofs.
  Verifying arbitrary zkApp proofs is the production design and is served by the
  separate [`o1js-to-zkvm`](https://github.com/youtpout) universal verifier.

## Naming

The product is **Flare x Mina**. Package and crate identifiers still carry the
`minaport` / `@minaport` prefix from the original working name — they are
internal names, not user-facing, and renaming them is a mechanical change kept
separate from behaviour.

## Licence

MIT
