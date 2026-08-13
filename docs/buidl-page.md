# Flare × Mina

**A Mina wallet that holds and trades assets on Flare — and never needs an EVM key.**

- **Live app** — https://flare-mina.labdevn.com
- **Demo video** — https://youtu.be/aYyipLVi2R8
- **Code** — https://github.com/youtpout/flare-mina

## About

Mina has world-class proving, one asset, and almost no liquidity. Flare has a
mature DeFi market and no MINA. Flare × Mina connects the two, in both
directions, and lets a Mina wallet act on Flare directly.

The obstacle is that a Mina key is a **Pallas** key: it cannot produce an ECDSA
signature, so it can never control an EVM account. The usual workaround is a
second wallet or a zero-knowledge proof. We needed neither.

The Pallas base field is a 255-bit prime, so it fits in a single EVM word and
`mulmod`/`addmod` operate on it natively. A Mina Schnorr signature can therefore
be verified **directly in a Solidity contract**:

| | |
|---|---|
| Verifying one Mina signature | **808,891 gas** |
| Cost on Flare | **$0.003** (650 gwei, 11 Aug 2026) |
| Same call on Ethereum | $0.17 today at 0.111 gwei — about $30 at 20 gwei |

That gap is the product. The design needs gas that is cheap *and* predictable,
and Flare is where it is both. No prover, no trusted setup, no proving artifacts.

## What works today

Deployed and public on **Coston2** and **Mina devnet**, both directions:

- **A Flare account owned by a Mina key.** Its address is `CREATE2` over your
  Mina public key, so it exists before anything is deployed. It holds tokens and
  executes signed batches of arbitrary calls.
- **MINA → Flare.** Lock native MINA in a Mina zkApp, receive fully
  collateralized **FMINA** on Flare — backed 1:1 by the escrow, not by
  over-collateralized third parties.
- **Flare → Mina.** FXRP, USD₮0 and C2FLR become **bFXRP**, **bUSDT** and
  **bC2FLR** on Mina — assets a Mina wallet could not hold before.
- **Trading.** Swap on BlazeSwap, a real DEX with real liquidity, with `approve`
  and `swap` under a **single Mina signature** over an ordered batch — so no
  approval is ever left live between two transactions.

## How the return path is secured

A Mina zkApp cannot read Flare, so something has to tell it what happened. The
answer to *who* is the whole security of a bridge, and ours is **nobody we
chose**.

Every transfer appends to one `TransferChain` on Flare. The **Flare Data
Connector** attests to its head each voting round, and Flare's validators sign
the Merkle root of the result. We verify that root, the Merkle proof and the
validator signatures **inside the Mina zkApp**, against the signing policy Mina
holds in its own state.

Mina never trusts our relayer. It checks Flare's validator signatures itself and
refuses anything they did not sign. One attestation serves the escrow and all
three token ports — paid once rather than four times.

## The swap is one example, not the feature

Only the DEX flow is wired into the interface, because a demo has to show
something concrete. `MinaAccount.executeBatch` accepts an ordered list of calls
with arbitrary target, value and calldata, checked against a signature over their
hash — no allowlist, no adapter, no notion of a DEX.

So it works with any Flare protocol, deployed today or next year, with no upgrade
to the account. Lending, staking, governance votes, NFT mints: what limits the
product is how many flows the interface builds, not what the account can execute.

## Built with

Flare (Coston2) · Flare Data Connector · Mina Protocol · o1js zkApps ·
Solidity · Auro Wallet · BlazeSwap

## Deployments

### Coston2 (chain 114)

| Contract | Address |
|---|---|
| `MinaAccountFactory` | [`0x2a2AcdD5…fe23`](https://coston2-explorer.flare.network/address/0x2a2AcdD54B93675828028fb8108fACc0A387fe23) |
| `MinaAuthRegistry` | [`0xcf12aCe3…fc56`](https://coston2-explorer.flare.network/address/0xcf12aCe3f7D13EE714D57ee22EfA14cbb662fc56) |
| `TransferChain` | [`0xB0a3Ab9d…fe4b`](https://coston2-explorer.flare.network/address/0xB0a3Ab9dE1527Ca617995b51E1548B40E0c9fe4b) |
| `MinaPortBridge` (proxy) | [`0x87149341…97aB`](https://coston2-explorer.flare.network/address/0x871493412EDCcfE0d24f127E6Deb2B20AE5497aB) |
| `AssetVault` (proxy) | [`0xa179E908…9F90`](https://coston2-explorer.flare.network/address/0xa179E908C3F1156Edda0BD5f1A0B3b3f419f9F90) |
| `FMINA` | [`0x4aFce36d…F046`](https://coston2-explorer.flare.network/address/0x4aFce36d468136eD9d880E28C99373F0C3d3f046) |
| An example account, source verified | [`0x6fC68C6d…D542`](https://coston2-explorer.flare.network/address/0x6fC68C6d69c252F57586d2159a5bf6D2BA65D542?tab=contract) |

That last one is the whole claim in a single link: a contract owned by a Mina
key that cannot sign for it.

### Mina devnet

| | Address |
|---|---|
| Bridge escrow | [`B62qpRkb…mkaDr6`](https://minascan.io/devnet/account/B62qpRkbjE5wH6nFmZnVUN7yrjfAhpJPP2qXxn6z7KQsL6RojmkaDr6) |
| bFXRP token | [`B62qnmNC…mP3XVN`](https://minascan.io/devnet/account/B62qnmNChAeU6SpLDdze7FvVjoT4LsWCcHntiqmFx1aBvrd52mP3XVN) |
| bFXRP port | [`B62qqvnf…HEPvZAM`](https://minascan.io/devnet/account/B62qqvnfG24NDLd3Byi6et85MPztrrCbTRKCN8vsoMP19konHEPvZAM) |
| bUSDT token | [`B62qjhVg…EH6Bg3`](https://minascan.io/devnet/account/B62qjhVgqAbso6g8wsLNosuUMTyySicoqtgEbGGPYqWJXDCdQEH6Bg3) |
| bUSDT port | [`B62qrQ8v…xscMfY`](https://minascan.io/devnet/account/B62qrQ8v16mWqmt5sY8MEDdeLyjPqU1JE2Cg6qcvpxUuMhomZxscMfY) |
| bC2FLR token | [`B62qiVgu…ukdQHQ`](https://minascan.io/devnet/account/B62qiVguTBzDp5vaHyTatzaQ2zTyhfU22tTi3VQ9MKfcnbnePukdQHQ) |
| bC2FLR port | [`B62qk3V1…Bd5nrc`](https://minascan.io/devnet/account/B62qk3V13bN1DfkGPRYj8zAuzuCxGitxfHwTuwAswZ4wA3GiEBd5nrc) |

## Honest about the limits

The deposit path settles against a mock verifier rather than a real SP1 one.
The reason is budget, and nothing else.

Verifying a Mina blockchain SNARK inside a zkVM is **4.38 billion cycles** —
about **40 minutes** on an RTX 5090, or **3 minutes** on the Succinct prover
network. Forty minutes is fine for a bridge; latency was never the obstacle.
What we do not have is a way to pay for it: the network bills per proof, and the
local route means dedicated GPU hardware running continuously. Either way, a
testnet demonstration would cost real money on every single deposit.

So the verifier was left swappable instead of faked further. The guest, its
cycle counts and the host CLI are in the repository; replacing the mock is a
`proposeVerifier` / `executeVerifierUpdate` pair behind a two-day timelock — no
redeploy, no migration. The full list of trust assumptions is in
`docs/threat-model.md`.

## Next

- **Real Mina proving, verified on Flare.** Replace the mock with the SP1
  settlement verifier, so the deposit path stops depending on a trusted attestor
  and a Mina state transition is proven rather than asserted.
- **Charge a fee for using our relayer**, so the service pays for its own
  proving and gas instead of being subsidised — the same fee that makes the
  point above affordable.
- **Pay gas in FMINA.** A contract cannot send its own transaction, so somebody
  has to submit it and pay the C2FLR — today that is our relayer, for free. The
  account should reimburse whoever submits, out of the FMINA it already holds.
  Anyone then has a reason to do it, and the user never needs native gas or an
  EVM account of their own.
- **More protocol flows in the interface** — lending, staking, governance. The
  account already executes them; only the frontend is missing.
- **Proofs on the same rail as assets**: a Mina zkApp proving something
  expensive off-chain, verified on Flare for a fraction of running it there.
