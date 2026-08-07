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

### Decimals: exact parity, never converted

A bridged token keeps the **same decimals on both chains**, and the bridge
performs no arithmetic on amounts. `100000` base units is `0.1 USDT` on Flare and
`0.1 USDT` on Mina, checkable by comparing two integers.

That is only achievable for tokens Mina can represent: its fungible token
standard holds balances in `UInt64`, capping a supply at ~1.845e19 base units.

| Asset | Decimals | Max supply on Mina | Path |
|-------|----------|--------------------|------|
| USD₮0 | 6 | 18 trillion | crosses unchanged |
| FXRP | 6 | 18 trillion | crosses unchanged |
| FMINA | 9 | 18 billion | crosses unchanged |
| WETH | 18 | **18.4** | **must be wrapped** |

WETH cannot be represented at all, so it goes through `BridgeWrapper` to a
9-decimal `bWETH` first. That wrap is the only place decimals ever change, and it
**refuses** any amount that would lose dust rather than truncating — `roundDown`
and `dust` let the frontend show what would be given up before the user commits.
Losing precision is a decision, not a side effect of bridging.

9 is not arbitrary: it is MINA's own precision, and the largest value leaving
realistic supplies representable. At 12 decimals `UInt64` caps at ~18 million
whole tokens, below ETH's circulating supply.

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

The bridge, its libraries and the proxy:

```sh
forge script script/DeployBridge.s.sol --rpc-url $COSTON2_RPC_URL \
  --with-gas-price 700gwei --legacy --broadcast
```

Both flags are required on Coston2. Without `--with-gas-price` forge estimates at
roughly four times the real cost and refuses to broadcast on a balance that is
in fact ample — 40 C2FLR demanded for a deployment that cost 9.8. Without
`--legacy` the send fails with *max priority fee per gas higher than max fee per
gas*, because `--with-gas-price` caps the max fee but not the priority fee.

Then the Mina side:

```sh
set -a && . ./.env && . ./apps/relayer/.env && set +a
pnpm --filter @minaport/mina-contracts exec tsc -p tsconfig.json
node packages/mina-contracts/dist/scripts/deployBridge.js
```

Built first, and run from `dist`, deliberately: `tsx` does not emit decorator
metadata, so o1js `@method` classes fail to load under it with
`Cannot read properties of undefined (reading 'map')`.

Two contracts, no constructor secrets, no owner, no upgrade path. Neither holds
funds and neither has an admin, so there is nothing to configure afterwards and
nothing to trust.

## Deployments

### Coston2 (chain 114) — live

| Contract | Address |
|----------|---------|
| `MinaAuthRegistry` | `0xcf12aCe3f7D13EE714D57ee22EfA14cbb662fc56` |
| `MinaAccountFactory` | `0x2a2AcdD54B93675828028fb8108fACc0A387fe23` |
| `MinaPortBridge` (proxy) | `0x871493412EDCcfE0d24f127E6Deb2B20AE5497aB` |
| ↳ implementation | `0xf171a25Dc8fbED4a312eE690728E22634A1EcF14` |
| `FMINA` | `0x4aFce36d468136eD9d880E28C99373F0C3d3f046` |
| `BridgeWrapperFactory` | `0xE4BB8D56CdF6C44Cc8878A636f77C352768f1b8b` |
| `AssetVault` (proxy) | `0xa179E908C3F1156Edda0BD5f1A0B3b3f419f9F90` |
| ↳ implementation | `0x6448436009439d220Bfc20ADd0353eAB3C4878De` |
| `bWC2FLR` wrapper | `0x6C790956D728ed82A75d2ec8D5c37F2e2F36b978` |
| `MockSettlementVerifier` | `0x6960d1119FeC5e7eA18C1CA64f7E614B61ea4506` ⚠️ |

The bridge sits behind a **transparent proxy**: integrate against the proxy
address, never the implementation. Upgrades go through the `ProxyAdmin` the
proxy deployed for itself, owned by the deployer.

Transparent rather than UUPS because the implementation is close to the EIP-170
limit — UUPS would put the upgrade machinery inside it. `PoseidonPallas` and
`MinaSchnorr` are deployed as external libraries for the same reason; together
those three changes took the bridge from an undeployable 39,693 bytes to 19,323.

⚠️ **`MockSettlementVerifier` accepts any proof.** It exists so the deposit-batch
path can be exercised end to end before the SP1 pipeline is wired in. The deploy
script refuses to run on Flare mainnet for this reason, and replacing it is a
`proposeVerifier` / `executeVerifierUpdate` pair behind a two-day timelock.

Third-party contracts this deployment uses, all resolved from the chain rather
than from documentation:

| Contract | Address | How it was found |
|----------|---------|------------------|
| Flare contract registry | `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` | Same on every Flare network |
| FXRP | `0x0b6A3645c240605887a5532109323A3E12273dc7` | `AssetManagerFXRP.fAsset()` |
| USD₮0 | `0xC1A5B41512496B80903D1f32d6dEa3a73212E71F` | Faucet token, identified by transfer pattern |
| WNat (WC2FLR) | `0xC67DCE33D7A8efA5FfEB961899C73fe01bCe9273` | Registry name `WNat` |
| BlazeSwap router | `0x440602f459D7Dd500a74528003e6A20A46d6e2A6` | Only one of three with an FXRP pair |
| FXRP/USD₮0 pair | `0xDD598473f738df117Ee331bc07172481db60acBE` | `factory.getPair()` |

### Mina Devnet

| Contract | Address |
|----------|---------|
| Bridge escrow zkApp | [`B62qpRkbjE5wH6nFmZnVUN7yrjfAhpJPP2qXxn6z7KQsL6RojmkaDr6`](https://minascan.io/devnet/account/B62qpRkbjE5wH6nFmZnVUN7yrjfAhpJPP2qXxn6z7KQsL6RojmkaDr6) |

Bridged Flare assets, each a `FungibleToken` whose admin is an `AssetPort`:

| Asset | Decimals | Token | Port |
|-------|----------|-------|------|
| bFXRP | 6 | `B62qnmNChAeU6SpLDdze7FvVjoT4LsWCcHntiqmFx1aBvrd52mP3XVN` | `B62qqvnfG24NDLd3Byi6et85MPztrrCbTRKCN8vsoMP19konHEPvZAM` |
| bUSDT | 6 | `B62qjhVgqAbso6g8wsLNosuUMTyySicoqtgEbGGPYqWJXDCdQEH6Bg3` | `B62qrQ8v16mWqmt5sY8MEDdeLyjPqU1JE2Cg6qcvpxUuMhomZxscMfY` |
| bC2FLR | 9 | `B62qiVguTBzDp5vaHyTatzaQ2zTyhfU22tTi3VQ9MKfcnbnePukdQHQ` | `B62qk3V13bN1DfkGPRYj8zAuzuCxGitxfHwTuwAswZ4wA3GiEBd5nrc` |

Every port shares one verification key —
`4521156475796503052894684743334034318326128329903794096474956123702318054773` —
because they run the same circuit against different tokens.

Decimals are never converted: `100000` base units is `0.1 USDT` on both chains,
so the backing invariant is an integer comparison. FXRP and USD₮0 are 6 on Flare
and stay 6 here. C2FLR is the exception — at 18 decimals a `UInt64` caps out at
**18 whole tokens**, so `lockNative` wraps it through `WNat` and down to the
9-decimal `bWC2FLR` before it crosses, and `releaseNative` unwinds both on the
way back. A user never handles either wrapper.


Deployment parameters, which the return path depends on:

| | |
|---|---|
| verification key hash | `5591623431868824314820851447908992564533139088677005722643394657802396877484` |
| `signingPolicyRoot` | `9573309213728131632191235555805511915574463302731318985515435894312670369468` |
| `requiredWeight` | `32767` — Coston2's real threshold, half of 65,534 |

`signingPolicyRoot` is a Poseidon Merkle root over Flare's validator set, built
by `packages/mina-contracts/scripts/fetchPolicyTree.ts` from `Relay` calldata and
checked against `Relay.toSigningPolicyHash`. Coston2 rotates its signing policy
every 6 hours, so this value goes stale four times a day; the relayer's publisher
rebuilds it and calls `setSigningPolicyRoot` on its own.

`setVerificationKey` is `signature()`, so circuits can be replaced without
abandoning the escrow — but only by the zkApp's own key, which is the one thing
in this deployment that cannot be recovered if lost.

Deposits go through the zkApp's `deposit` method, which carries the Flare
recipient as a 160-bit field element and dispatches the deposit action in the
same
proved transaction.

`send`, `receive` and `editState` are all `Permissions.proof()`, so value moves
in **and out** only through a proved method. A key holding the escrow could rug
it; this cannot.

`receive` is as strict as `send` for a reason worth stating: an ordinary payment
would credit the balance without ever dispatching an action, so nothing on
Flare could claim it — a permanent loss, silently. Refusing the payment is the
only outcome that leaves the sender's MINA usable. An earlier deployment allowed
plain payments and stranded 30 devnet MINA exactly this way.

It is also what lets the contract keep no balance accounting of its own: if the
only way in is `deposit` and the only way out is `releaseWithdrawal`, the account
balance *is* the escrowed total.

Verification key hash:
`21021527467738518535788016258937719174547704517215919313249690369595765354609`

### Flare mainnet (chain 14) / Mina mainnet

Nothing deployed, deliberately. The mock verifier makes a mainnet deployment
unsafe, and the deploy script enforces that rather than relying on operator
discipline.

## Status

| Component | State |
|-----------|-------|
| `Pallas`, `PoseidonPallas`, `MinaSchnorr` | Working, 33 tests |
| `MinaAuthRegistry` | Working end to end, 12 tests |
| `MinaAccount` + factory | Working, 17 tests, signatures via FFI at run time |
| Coston2 fork test | Passing against live chain state |
| `FMINA`, `MinaPortBridge` | Working, 41 tests (118 Solidity in total) |
| `packages/shared` | 50 tests |
| `minaport-schnorr` (Rust) | 9 tests against real Mina signatures |
| `mina-contracts` zkApp | Deployed to devnet, 12 + 16 tests |
| Frontend + attestor API | Working, 8 relayer tests |

## Known limitations

Stated plainly so they are never mistaken for solved problems. Each one is
analysed in full — bound, mitigation, and what removes it — in
[docs/threat-model.md](docs/threat-model.md).

- **The Flare → Mina return path uses a trusted attestor**, not FDC + Relay
  signing-policy verification. Full trust-minimisation of the return path is out
  of reach in the hackathon window.
- **The Mina → Flare deposit path uses a trusted escrow attestor.** It cannot
  choose a recipient or an amount — the depositor's Schnorr signature covers
  both — but it can attest to an escrow that never happened. On-chain per-deposit
  and cumulative mint ceilings bound what that is worth.
- **`MockSettlementVerifier` accepts any proof.** It exists so the bridge tests
  can exercise the deposit flow, and must never be deployed to a network holding
  value.
- **Bridging Flare assets toward Mina** (FXRP, USD₮0, WETH) depends on the
  trustless return path, and is roadmap rather than MVP.

## Roadmap: where proving earns its place

`packages/prover` contains a working SP1 guest that verifies Mina Schnorr
signatures, measured at **~2.0M cycles** marginal per signature with ~1.2M fixed
overhead, and a host CLI that produces real proofs (core proof generated and
verified in 1m43s on a laptop).

For *signatures* it is deliberately **not** on the MVP path, because on Flare
direct verification is cheaper in every dimension that matters: no relayer, no
proving artifacts, no multi-minute wait, no trusted setup.

Where proving is irreplaceable is the **trust-minimised bridge** — attesting to
Mina zkApp *state transitions*, which no amount of on-chain curve arithmetic can
do. That is well beyond a hackathon window: it means running a prover in
production, deploying a verifier, and getting the whole thing audited.

What can be said is that the cryptography is not the blocker. A universal Mina
Pickles verifier already runs in a zkVM against a real Mina **mainnet**
blockchain SNARK, in two ports sharing one verifier core:

| | measured on the same input |
|---|---|
| [o1js-to-zkvm](https://github.com/youtpout/o1js-to-zkvm) — SP1 | 4,378,867,074 cycles |
| [o1-openvm](https://github.com/youtpout/o1-openvm) — OpenVM rv64 | 898,656,552 instructions / 32.1B trace cells |

OpenVM gets there by declaring Pallas and Vesta as first-class curves
(`moduli_declare!` + `sw_declare!`) rather than waiting for a precompile —
**×35.41** over the unaccelerated build. The two figures are different units and
the cross-zkVM ratio is indicative only; see
[docs/threat-model.md §6.3](docs/threat-model.md) for the full table and the
caveats.

Both are **research prototypes — unaudited, and not ready to secure a bridge.**
They establish feasibility and cost, and they show there is gas headroom: the
OpenVM Solidity SDK verifies on any EVM chain for **under 330k gas**, less than
the 809k this project already pays for a single Schnorr verification. Turning
that into a settlement path means binding the statement, running a prover, and
an audit — a programme of work, not a next commit. `IMinaSettlementVerifier` and
its timelocked rotation exist so that day is a swap rather than a redesign.

Also on the roadmap: batching. The wrap is a fixed cost, so amortising it across
many deposits is what keeps proving competitive — and it is why settlement is
batched rather than per-deposit.

## Licence

MIT
