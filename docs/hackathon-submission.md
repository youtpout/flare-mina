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
| Coston2 | Deployment target for every contract | TODO: deploy |
| FXRP | Swap pair against FMINA — the priority asset for this bounty | TODO |
| FTSO | Price feed for MINA/USD and swap quoting in the UI | TODO |
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
| [`o1js-to-zkvm`](https://github.com/youtpout) | Universal Pickles verifier inside SP1 | Ours, earlier work |
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

| Contract | Network | Address |
|---|---|---|
| `MinaAuthRegistry` | Coston2 | TODO |
| `MinaAccountFactory` | Coston2 | TODO |
| `FMINA` | Coston2 | TODO |
| `MinaPortBridge` | Coston2 | TODO |
| `BridgeWrapperFactory` | Coston2 | TODO |

## Demo

- Video: TODO
- Live app: TODO
- Repository: https://github.com/youtpout/flare-mina

## Trust assumptions

Stated so they are never mistaken for solved problems.

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
- **Batched authorization via SP1.** `packages/prover` already contains a working
  SP1 guest verifying Mina signatures at ~2.0M cycles marginal. It is not on the
  MVP path because direct verification is cheaper on Flare in every dimension,
  but it becomes the right answer on chains where gas, not proving, binds — and
  for proving zkApp *state transitions*, which on-chain curve arithmetic cannot
  replace.
- **FBTC and further FAssets** as swap pairs.

## Distribution and traction

TODO — pilot users, community interest, partner conversations.
