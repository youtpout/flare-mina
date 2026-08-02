# Flare Summer Signal — Submission

> Working document. Placeholders are marked `TODO` and must be filled before the
> 14 August deadline.

## Project name

**Flare x Mina**

## Selected bounty

**Bounty 1 — Interoperable Asset Products**

## Short product description

Flare x Mina lets a Mina wallet hold, move and trade assets on Flare, and brings
native MINA to Flare as a fully collateralized ERC-20.

Two things are new here. The first is the asset: MINA becomes tradeable against
Flare liquidity for the first time. The second is the account model — a Mina key
can own and operate a Flare account **without ever holding an EVM key**, because
its signature is verified directly on-chain.

## Target user

- **MINA holders** who want a working DeFi market. Mina's own DeFi is thin and
  every interaction there costs a proof; Flare has liquidity and cheap execution.
- **Flare users and protocols** who gain a new asset and a new user base.
- **Wallet and bridge developers** who need a reference for verifying Mina
  signatures on an EVM chain — the library is standalone and reusable.

## How the project uses Flare

This is the section a judge should read most carefully, so it is answered
directly rather than by listing integrations.

### Flare makes the product possible, not merely host it

The core of the product is verifying a **Mina Schnorr signature over the Pallas
curve inside a Solidity contract**, with no zero-knowledge proof anywhere.

That is possible because the Pallas base field is a 255-bit prime: it fits in one
EVM word, so `mulmod` and `addmod` handle it natively at 8 gas each. We measured
the result and then optimised it:

| | Gas | Cost on Flare | Cost on Ethereum @20 gwei |
|---|---|---|---|
| Reference implementation | ~1.79M | — | ~$107 |
| **This project** | **808,891** | **~$0.009** | ~$48 |

**The same contract is a product on Flare and an impossibility on Ethereum.**
Flare's economics are not a convenience here; they are the reason the design is
viable at all. A judge can verify this by comparing the two right-hand columns.

Measured against live Coston2 state, one full account operation costs **865,845
gas — 3% of a block** (block gas limit 28,000,000, base fee 500 gwei).

### Flare's attestation layer makes the return path tractable

Bridging out of Flare is structurally cheaper than bridging in, and that is a
property of Flare's architecture rather than a convenience.

| Direction | What must be proven | Cost |
|---|---|---|
| Mina → Flare | A recursive Pickles/Kimchi proof | Heavy — hundreds of millions of zkVM cycles |
| **Flare → Mina** | **ECDSA signatures from a known signing policy, plus a Merkle proof** | **31,810 constraints per signature** |

Flare's data layer publishes Merkle roots signed by a weighted validator set
using secp256k1 ECDSA. Proving a Flare event on Mina therefore reduces to
verifying those signatures — no recursive SNARK verification anywhere. We
measured one verification inside a zkApp at **31,810 constraints**
(`packages/mina-contracts/bench/ecdsaConstraints.mjs`), which fits comfortably
inside a single Mina method, so a full signing-policy threshold is a routine
recursive fold rather than a research problem.

Note that FDC cannot help in the inbound direction: **Mina is not an FDC source
chain**, so a Mina deposit cannot be attested to Flare and must be proven by the
escrow zkApp instead. The asymmetry is real and is what shapes the design — it
is why the outbound path is on the near roadmap while the inbound path carries
the heavier machinery.

### Flare infrastructure used

| Component | How it is used | Status |
|---|---|---|
| Coston2 | Every contract is deployed and exercised here | **Done** |
| FXRP | Swapped on-chain from a Mina-owned account, against live BlazeSwap liquidity | **Done** |
| FTSO | Price feed for portfolio valuation and quoting | Resolved from the registry; UI pending |
| FDC | `EVMTransaction` attestation of the burn, for the trust-minimised return path | Roadmap — see below |

### FMINA and FAssets

FMINA is named to match Flare's convention (FXRP, FBTC, FDOGE), but **it is not
an official FAsset**, and the difference favours the holder:

| | FAssets (FXRP) | FMINA |
|---|---|---|
| Collateral | Third-party agents over-collateralize in FLR | The MINA itself, 1:1 |
| Guarantee | Economic — liquidation, price feeds | Cryptographic — proven escrow |
| Failure mode | Agent default, collateral volatility | None of the above |

## Dependencies

Flare x Mina is a new product built during the program. It stands on libraries,
some of which we wrote earlier — listed here for completeness, not because a
prior version of this product existed.

| Library | What it provides | Author |
|---|---|---|
| [`pallas_curve_verifier`](https://github.com/youtpout/pallas_curve_verifier) | Reference Pallas + Poseidon + signature verification in Solidity | Ours, earlier work |
| [`o1js-to-zkvm`](https://github.com/youtpout/o1js-to-zkvm) | Universal Pickles verifier inside SP1 | Ours, earlier work |
| [`o1-openvm`](https://github.com/youtpout/o1-openvm) | The same verifier core on OpenVM, with Pallas and Vesta as declared curves | Ours, earlier work |
| `mina-signer`, `o1js`, `mina-fungible-token` | Mina's official libraries | o1Labs |
| `forge-std`, OpenZeppelin contracts | Solidity tooling and primitives | — |

The optimisation figures below are quoted against the first of these, since a
2.2x improvement only means something relative to a baseline.

## What was newly built during the hackathon

Everything in this repository. Specifically:

**A faster verifier.** The pre-existing implementation reports 1.6M gas for a
two-field message and 2.4M for nineteen, interpolating to ~1.79M at the six-field
message this product uses. It is now **808,891** — roughly 2.2x — and every step
is measured:

| Change | Effect |
|---|---|
| Poseidon round constants moved from a storage array into bytecode | removes 165 cold SLOADs (~346k gas) |
| Strauss-Shamir: one shared doubling chain instead of two scalar multiplications | −43% on the curve work |
| `optimizer_runs` 200 → 100,000 | −26% overall |
| Mixed addition against affine window tables | included above |
| Comparing `R.x` projectively instead of a second field inversion | one modexp saved |

Two approaches were tried and **rejected on measurement**, which is recorded so
nobody repeats them: hand-written Yul was 1.83x *slower* than the Solidity it
replaced, and computing the public key's `y` on-chain is not viable because
Pallas has `P ≡ 1 (mod 4)`, so the cheap square-root identity does not apply.

**A Flare account owned by a Mina key.** `MinaAccount` holds tokens and executes
arbitrary calls against a Schnorr signature. Its address is `CREATE2` over the
Mina key, so a Mina wallet has a Flare address before anything is deployed.
Anyone may submit the transaction — target, value and calldata are all committed
to by the signed `actionHash` — so there is no privileged relayer.

**A proof-gated token admin for Mina.** The standard `FungibleTokenAdmin.canMint`
requires an admin signature, which for a bridge collapses every cryptographic
guarantee onto one key. Ours trusts no key: it verifies that the mint matches a
claim proven against a published lock root, consumes a nullifier, and clears the
authorisation so it cannot be reused.

**A decimal policy that cannot silently lose funds.** Bridged tokens keep
identical decimals on both chains. Mina's `UInt64` balances make 18-decimal
tokens unrepresentable (18.4 WETH maximum), so WETH goes through a wrapper that
**refuses** amounts that would lose dust rather than truncating them.

**Cross-language canonical encodings** with shared fixtures read by the
TypeScript, Rust and Solidity suites, so an encoding drift fails a test rather
than stranding funds.

## Latency a user actually experiences

| Action | Where | Time / cost |
|--------|-------|-------------|
| Sign a deposit intent | Mina wallet | instant |
| Prove a claim on Mina | o1js, client | **4.2 s** |
| Move tokens on Flare | Coston2 | **~890k gas, ~$0.009** |
| Swap on Flare | Coston2 | **~1.08M gas**, one signature |

No step in the product costs a user minutes. That is the point of verifying
signatures directly rather than wrapping proofs: the only multi-minute operation
in the repository is the SP1 pipeline, which is deliberately off the MVP path.

## Technical execution

| Suite | Tests |
|---|---|
| Flare contracts (curve, Poseidon, signature, account, registry, wrapper, bridge, token) | 97 |
| Mina contracts (proof-gated admin, end-to-end mint with real proofs) | 16 |
| Shared encodings (TypeScript) | 38 |
| Pallas Schnorr verifier (Rust, `no_std`) | 9 |

Signature tests do not use pasted constants. The Foundry suite calls
`mina-signer` through FFI at run time, so the on-chain verifier is pinned to the
reference library rather than to a snapshot of it. The Rust verifier is tested
against signatures from o1js `Signature.create`.

Tests are adversarial before they are confirmatory. The Mina suite mints without
a claim, replays claims, mints wrong amounts and mints to wrong recipients — all
refused, with the rejection *reason* asserted, so a right answer for a wrong
reason fails.

## Deployment

Deployed and **live on Coston2** (chain 114).

| Contract | Address |
|---|---|
| `MinaAuthRegistry` | [`0xcf12aCe3f7D13EE714D57ee22EfA14cbb662fc56`](https://coston2-explorer.flare.network/address/0xcf12aCe3f7D13EE714D57ee22EfA14cbb662fc56) |
| `MinaAccountFactory` | [`0x2a2AcdD54B93675828028fb8108fACc0A387fe23`](https://coston2-explorer.flare.network/address/0x2a2AcdD54B93675828028fb8108fACc0A387fe23) |
| `FMINA` | [`0x68189e3a6F0Ef2D1accFd62b6De9abF791B3722e`](https://coston2-explorer.flare.network/address/0x68189e3a6F0Ef2D1accFd62b6De9abF791B3722e) |
| `MinaPortBridge` | [`0xdb78DA6dd5eC73b7089799eE85Fc2E43126CBae2`](https://coston2-explorer.flare.network/address/0xdb78DA6dd5eC73b7089799eE85Fc2E43126CBae2) |
| `BridgeWrapperFactory` | [`0x98f0CA385dBe0724b4D9211fA4e515eB4d6848b7`](https://coston2-explorer.flare.network/address/0x98f0CA385dBe0724b4D9211fA4e515eB4d6848b7) |
| `MockSettlementVerifier` | [`0xDF7519725DE130Ce083395D0e9Da6E31b5D04eEe`](https://coston2-explorer.flare.network/address/0xDF7519725DE130Ce083395D0e9Da6E31b5D04eEe) — **accepts any proof, testnet only** |

### The bridge path, exercised on-chain

| Step | Result |
|---|---|
| Submit a two-deposit batch | root `0xd463d4a6…` accepted, batch nonce 1 |
| Claim deposit 0 (2,000 FMINA) | minted to the deployer |
| Claim deposit 1 (500 FMINA) | minted to the Mina-owned account |
| `collateralInvariantHolds()` | **true** |

Both claims carried a real Merkle proof against the accepted root. The mint
authority is the bridge and nothing else: `FMINA.mint` reverts for any other
caller, which the test suite covers.

The deployment script **refuses to run on Flare mainnet**, because it deploys the
mock verifier and a mock verifier on a live chain is an unbounded mint. Swapping
in the real verifier is a `proposeVerifier` / `executeVerifierUpdate` pair behind
a two-day timelock — no redeployment, and the rotation is visible on-chain.

### A Mina key moving real tokens on Flare

The claim at the top of this document is not a diagram. Here it is happening on
Coston2, with a Mina key that has no EVM key of its own:

| Step | Transaction | Gas |
|---|---|---|
| Deploy the account for Mina key `B62…` | [`0x540928c4…`](https://coston2-explorer.flare.network/tx/0x540928c4bd9c606f2023789d3bba7086a8f4178aeb3e9ff082687d8020d73a4b) | 835,688 |
| Fund it with 5 USD₮0 | [`0x175c7134…`](https://coston2-explorer.flare.network/tx/0x175c71344471d43c50ef2fc978df7961a2449269f265da7b99de43eadc4c77d5) | — |
| **Transfer 2 USD₮0, authorised only by a Mina Schnorr signature** | [`0x2158871c…`](https://coston2-explorer.flare.network/tx/0x2158871cb9392f83789e15d140fc7923e98fc5d3e5d2d608bb4aca1cde9a69c6) | **889,791** |
| **Swap 1 USD₮0 → FXRP on BlazeSwap — `approve` + `swap` under one signature** | [`0x496968b3…`](https://coston2-explorer.flare.network/tx/0x496968b30ddc54162d3c56c02c5f986b5e315d154cb2e48dbea365a3454fcdf3) | **1,075,599** |

The account is [`0xF110b6095EbaA987191F555093c9357eb8C61b7b`](https://coston2-explorer.flare.network/address/0xF110b6095EbaA987191F555093c9357eb8C61b7b),
which is `CREATE2` over the Mina public key — it was computable, and shown by
`accountOf()`, before any of the three transactions existed.

The USD₮0 is the real faucet token, not a mock, and the swap is against a real
DEX with real liquidity — not a pool we deployed for the demo:

| | |
|---|---|
| DEX | BlazeSwap, router [`0x440602f4…`](https://coston2-explorer.flare.network/address/0x440602f459D7Dd500a74528003e6A20A46d6e2A6) |
| Pair | FXRP / USD₮0, [`0xDD598473…`](https://coston2-explorer.flare.network/address/0xDD598473f738df117Ee331bc07172481db60acBE) |
| Quoted | 1.000000 USD₮0 → 0.792091 FXRP |
| Received | **0.792091 FXRP**, exactly |

The account ends holding 2.000000 USD₮0 and 0.792091 FXRP. `approve` and `swap`
went through as **one Mina signature** over an ordered batch, so no live approval
ever sat between two transactions.

Nothing in the account knows what BlazeSwap is. It executes a signed list of
calls, which is why it works with any DEX on Flare and needs no adapter, no
allowlist, and no upgrade when the next one launches.

## Demo

- Video: TODO
- Live app: TODO
- Repository: https://github.com/youtpout/flare-mina
- On-chain evidence: the three transactions above, on a public explorer

## Trust assumptions

Stated so they are never mistaken for solved problems. Analysed in full — assets,
actors, attack scenarios, and what removes each gap — in
[docs/threat-model.md](threat-model.md).

1. **The Flare → Mina return path uses a trusted attestor**, not FDC + Relay
   signing-policy verification. It is one explicit state field on the Mina side;
   replacing it changes nothing else in the contract.
2. **`MockSettlementVerifier` accepts any proof.** It exists for the bridge tests
   and must never be deployed to a network holding value.
3. **Mina's own network separation is absent from field signatures.**
   `mina-signer` 4.1.0 hardcodes the devnet domain in `signFields`, so every
   field signature carries it on every network. We do not rely on it: chain
   binding comes from the `chainId` inside the signed message.
4. **Gas.** A Mina key authorises but cannot pay; some EVM account must submit.
   It need not be trusted, but it must exist.
5. **The Mina → Flare escrow attestor can mint unbacked FMINA.** It cannot choose
   a recipient or an amount — the depositor's on-chain-verified Schnorr signature
   covers both — so this is a solvency risk to holders, not a theft from an
   individual. Bounded on chain by a per-deposit ceiling and a cumulative cap,
   which can be lowered instantly and raised only after a 2-day timelock.

## Roadmap

**Immediately after the hackathon**

- **Reimburse the submitter in FMINA** from the account's own balance, removing
  the last reason for a Mina user to hold an EVM account at all. Anyone submits
  to earn the fee, which makes censorship economically pointless.
- **FDC-verified return path.** Request an `EVMTransaction` attestation of the
  burn, verify the Relay signing policy and Merkle proof inside a Pickles circuit,
  and drop the attestor entirely.

**Beyond**

- **Flare assets on Mina** — FXRP, USD₮0 and WETH as `FungibleToken` zkApps, with
  decimals preserved exactly. Depends on the trust-minimised return path.
- **Proven settlement, retiring the escrow attestor.** The cryptography is not
  the blocker: a universal Mina Pickles verifier runs in a zkVM today against a
  real Mina *mainnet* blockchain SNARK, measured at 898,656,552 instructions on
  OpenVM with Pallas and Vesta declared as first-class curves (×35.41 over
  unaccelerated), and at 4,378,867,074 cycles on SP1 with the same verifier core.
  There is gas headroom too — the OpenVM Solidity SDK verifies under 330k gas on
  any EVM chain, less than the 809k this project already pays for one Schnorr
  signature. Both ports are **unaudited prototypes**, and turning them into a
  settlement path means running a prover in production and an audit — well beyond
  a hackathon. `IMinaSettlementVerifier` and its timelocked rotation exist so
  that becomes a swap rather than a redesign.
- **Batched authorization.** Proving is the wrong tool for individual signatures
  on Flare, where direct verification is cheaper in every dimension. It becomes
  the right answer on chains where gas, not proving, binds.
- **FBTC and further FAssets** as swap pairs.

## Distribution and traction

TODO — pilot users, community interest, partner conversations.
