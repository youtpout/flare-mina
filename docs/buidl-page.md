# DoraHacks BUIDL page — content to paste

Written for https://dorahacks.io/buidl/47445, which still describes the earlier
MetaMask-Snap design. Shorter and less technical than the README on purpose: a
reviewer reads this in a minute and follows a link if convinced.

---

## Tagline

> A Mina wallet that holds and trades assets on Flare — and never needs an EVM key.

---

## Links

- **Live app** — https://flare-mina.labdevn.com
- **Demo video** — https://youtu.be/aYyipLVi2R8
- **Code** — https://github.com/youtpout/flare-mina

---

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

**Coston2** — `MinaAccountFactory` `0x2a2AcdD54B93675828028fb8108fACc0A387fe23` ·
`MinaAuthRegistry` `0xcf12aCe3f7D13EE714D57ee22EfA14cbb662fc56` ·
`TransferChain` `0xB0a3Ab9dE1527Ca617995b51E1548B40E0c9fe4b` ·
`MinaPortBridge` `0x871493412EDCcfE0d24f127E6Deb2B20AE5497aB` ·
`FMINA` `0x4aFce36d468136eD9d880E28C99373F0C3d3f046` ·
`AssetVault` `0xa179E908C3F1156Edda0BD5f1A0B3b3f419f9F90`

An example account, source verified:
[`0x6fC68C6d…D542`](https://coston2-explorer.flare.network/address/0x6fC68C6d69c252F57586d2159a5bf6D2BA65D542?tab=contract)
— a contract owned by a Mina key that cannot sign for it.

**Mina devnet** — escrow `B62qpRkbjE5wH6nFmZnVUN7yrjfAhpJPP2qXxn6z7KQsL6RojmkaDr6`,
plus one `FungibleToken` and one `AssetPort` per bridged asset. Full list in the
repository.

## What is honest about the limits

The deposit path settles against a mock verifier rather than a real SP1 one.
That is cost, not capability: a core proof is free and runs in under two minutes
on a laptop, but Solidity cannot check a core proof — on-chain verification needs
the Groth16 wrap, which in practice means paying a prover network per proof. The
guest and its cycle counts are in the repository; the verifier is swappable
behind a two-day timelock. The full list of trust assumptions is in
`docs/threat-model.md`.

## Next

Reimburse the transaction submitter out of the account's own FMINA balance,
which removes the last reason to hold an EVM account at all. More protocol flows
in the interface. And, further out, the same rail carrying **proofs** rather than
assets: a Mina zkApp proving something expensive off-chain, verified on Flare for
a fraction of running it there.
