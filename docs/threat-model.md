# Threat model

This document says what Flare x Mina protects, who has to be trusted for that
to hold, what an attacker can try, and — for every gap that is still open — what
closes it and what closing it costs.

It is written to be falsifiable. Each mitigation names the code that implements
it and the test that exercises it. Where nothing implements it yet, the row says
so instead of describing an intention as though it were a control.

Scope: the contracts in `packages/flare-contracts` and `packages/mina-contracts`,
the attestor in `apps/relayer`, and the encoders in `packages/shared` that both
sides depend on agreeing about. The frontend is out of scope for custody — it
holds no keys and can produce nothing the contracts do not independently check.

---

## 1. What is being protected

| Asset | Where it lives | Loss looks like |
|---|---|---|
| Escrowed MINA | `MinaPortBridge` zkApp account on Mina | Released to someone who did not burn FMINA |
| FMINA supply | `FMINA` on Flare | Minted without a matching escrow, i.e. unbacked |
| Assets in a `MinaAccount` | Per-key CREATE2 contract on Flare | Moved without the owning Mina key's authorisation |
| The collateral invariant | Both chains | `totalSupply(FMINA) != escrowedNanomina` |

The invariant is the one that matters most, because every other failure shows up
as a break in it. `MinaPortBridge.collateralInvariantHolds()` reports it on
chain, and the Solidity suite asserts it after every state-changing operation.

## 2. Who is trusted, and for exactly what

The point of this section is the *for exactly what*. "There is an attestor" is
not a trust model; the useful statement is the smallest set of things that
attestor can do.

| Actor | Can | Cannot |
|---|---|---|
| **Escrow attestor** (Flare side, `escrowAttestor`) | Refuse to sign; sign for an escrow that never happened, minting unbacked FMINA | Choose the recipient, change the amount, mint to itself, move escrowed MINA, or touch an existing balance |
| **Withdrawal attestor** (Mina side, `withdrawalAttestor`) | Refuse to sign; attest a burn that never happened, releasing escrow | Choose the recipient or amount independently of the record it signs; release out of nonce order; exceed `lockedNanomina` |
| **zkApp admin** (Mina side, `admin`) | Rotate `withdrawalAttestor` | Move escrow, mint, or edit any accounting state — all of which are reachable only through proof-authorised methods |
| **Bridge owner** (Flare side, `Ownable2Step`) | Pause; rotate the settlement verifier after a 2-day timelock; rotate `escrowAttestor` | Mint, burn, move user funds, or bypass the timelock |
| **Transaction submitter** | Pay gas; decline to submit | Anything at all. Every field is committed to by a signature the submitter cannot alter |
| **Frontend / RPC** | Show wrong data; refuse to serve | Cause a bad state transition — contracts re-derive every digest they act on |

Two properties do real work here and are worth stating separately.

**The submitter is powerless by construction.** In `MinaAccount.execute` and
`executeBatch`, the target, value and calldata are all inside `actionHash`, which
is inside the signed message. There is no privileged relayer, so there is nobody
to censor by and nobody to bribe. One honest submitter is enough, and the
submitter need not be honest — only present.

**The two attestors are separate keys with separate powers.** The escrow
attestor can mint on Flare; the withdrawal attestor can release on Mina. They are
different keys on different chains, so compromising one does not compromise the
round trip. Verified on the deployed zkApp: `withdrawalAttestor` sits at state
slot 4 and `admin` at slot 6, and they hold different keys.

## 3. Trust boundaries

```
  Mina                              off-chain                      Flare
  ────                              ─────────                      ─────
  depositor key ──── signs intent ─────────────────────────────▶ verified
                                                                 on-chain
                                                                 (Pallas)
  escrow zkApp ───── observed by ──▶ attestor ─── ECDSA ────────▶ trusted
                                     (watcher)                    ← GAP 1

  release ◀───────── attests ─────── attestor ◀── burn event ──── emitted
   ← GAP 2                           (watcher)                    on-chain

  settlement verifier ◀───────────── SP1 proof ─────────────────▶ MOCK
                                     (roadmap)                    ← GAP 3
```

Everything crossing a `───▶` boundary is untrusted input and is re-derived on
arrival. The three gaps are enumerated in §5.

## 4. Attack scenarios

Each row: what an attacker tries, what stops it, where.

### 4.1 Against a `MinaAccount`

| Attack | Prevented by | Test |
|---|---|---|
| Replay a captured authorisation | Sequential per-key nonce consumed *before* the external call, so a reentrant call meets an advanced nonce | `test_rejectsReplay` |
| Present an authorisation to a different contract | `auth.target` must equal `msg.sender` | `test_rejectsWrongTarget` |
| Replay a Coston2 signature on Flare mainnet | `chainId` is inside the signed message. This is load-bearing — Mina's own network separation is absent from field signatures (§5.4) | `test_rejectsWrongChain` |
| Alter target, value or calldata in flight | All three are committed to by `actionHash`; `abi.encode`, not `encodePacked`, so a triple cannot be re-split | `test_rejectsTamperedActionHash` |
| Reorder a batch — run `swap` before `approve`, or strip a call | `batchHash` commits to the ordered list; the batch is atomic, so a granted approval cannot survive a failed swap | `MinaAccount.t.sol` |
| Drive one account with another key's valid signature | `MINA_KEY` is immutable and checked against the presented key | `WrongOwner` |
| Use a single-call signature to authorise a batch | Purpose tag is the **first** signed field | `test_signatureForOnePurposeDoesNotSatisfyAnother`, and the converse `test_batchSignatureDoesNotSatisfyACall` |
| Forge a signature by supplying a bogus `y` | `y` is a caller argument but pinned by the curve equation plus the parity bit | `Pallas.t.sol` |
| Front-run a deployment to seize an account address | Address is `CREATE2(minaKey)`; a third party deploying first changes nothing about who controls it | `MinaAccount.t.sol` |

The purpose tag deserves the emphasis it gets. Without it, an account
authorisation and a bridge deposit intent are *the same seven fields*, separated
only by their target addresses happening to differ — an accident of deployment,
not a property of the design. Redeploy one contract at the other's address, or
add a third feature that forgets to differentiate, and one signature authorises
two things. `SignaturePurpose` makes the separation structural.

### 4.2 Against the deposit path (Mina → Flare)

| Attack | Prevented by | Test |
|---|---|---|
| Attestor redirects a deposit to itself | The depositor's Schnorr signature covers recipient and amount, verified on-chain | `MinaSignatureDeposit.t.sol` |
| Attestor inflates an amount | Same — and the failure surfaces as `InvalidMinaSignature`, i.e. it is the *depositor's* signature that refuses |
| Depositor mints with no escrow | Attestor's ECDSA signature over the same digest is also required |
| Either party acts alone | Both are required; each covers what the other cannot |
| Replay an intent | `consumedIntents[intent]`, keyed by a digest that includes `chainId`, sender, recipient, amount and nonce | `IntentAlreadyConsumed` |
| Claim the same Merkle leaf twice | `claimedDeposits[leaf]` | `MinaPortBridge.t.sol` |
| Replay or skip a settlement batch | `previousActionState` must chain, `batchNonce` must be `last + 1` | `NonMonotonicBatchNonce` |
| Settle a devnet proof on a mainnet bridge | `BRIDGE_ID` is immutable and checked against the proof's public values | `UnexpectedBridgeId` |
| Steal someone else's claim by paying its gas | Minted tokens go to `deposit.recipientFlare`, which is inside the proof. There is no `msg.sender` check because there is nothing `msg.sender` could influence |
| Strand a deposit with a malformed memo | Memo parse is strict and refuses rather than guesses; a rejection is a value with a reason a user can be shown | `apps/relayer` tests |

### 4.3 Against the withdrawal path (Flare → Mina)

| Attack | Prevented by |
|---|---|
| Burn FMINA to a key that corresponds to no Mina account | `MinaAddressLib.fromBytes32` validates the recipient as a Pallas field element on the Flare side, before the burn |
| Burn more than Mina can represent | `amount > type(uint64).max` rejected — the Mina side accounts in `uint64` nanomina |
| Emit a claimable event without burning | Burn happens before the emit |
| Release more than is escrowed | `lockedNanomina` check on the Mina side | 
| Replay a release | `lastWithdrawalNonce` is strictly increasing |

One consequence is worth being explicit about, because it is a liveness cost
paid for an O(1) state saving: releases must be submitted **in nonce order**. A
skipped nonce permanently strands that withdrawal. This is a deliberate trade
and it is a real limitation, not a hypothetical one.

### 4.4 Against encoding

The two chains have to agree byte-for-byte about what was signed. A disagreement
is not a subtle bug — it is either a deposit that can never be claimed, or two
distinct actions sharing an encoding.

| Attack | Prevented by |
|---|---|
| Two distinct actions collide in one field element | `actionHash` is split 128/128 across two fields, because a 256-bit digest reduced modulo a ~254-bit field order would alias | `test_encodingSplitsActionHashLosslessly` |
| Non-canonical field encoding in the SP1 guest | Round-trip assertion after `from_be_bytes_mod_order`; a value at or above the modulus is rejected rather than silently reduced |
| Rust and TypeScript encoders drift | Cross-language fixture tests pin both against the same vectors |
| Two different Mina keys pack to the same `bytes32` | Packing is `x \| isOdd << 255`, injective because `x < 2^255` |

## 5. Open gaps

These are the trust assumptions. They are numbered so the roadmap can refer to
them, and each one has a named replacement rather than a hope.

### GAP 1 — The escrow attestor can mint unbacked FMINA

**What.** `claimWithMinaSignature` requires an ECDSA signature from
`escrowAttestor` asserting that MINA was escrowed on Mina. A signature cannot
prove custody — it proves intent. Somebody has to look at the Mina chain, and
until Mina state is proven on Flare, that somebody is trusted.

**Bounded by.** The depositor's signature, which fixes the recipient and the
amount. A dishonest attestor cannot choose who benefits, so the attack is
"inflate the supply", not "steal a user's funds". It is a solvency attack on
holders, not a theft from an individual.

**Also bounded by** on-chain mint ceilings, per deposit and cumulative (§6.1).
The relayer applies a per-deposit ceiling of its own in `AttestorPolicy`, but
that is an honest attestor restraining itself and is worth nothing once the key
is out of the relayer's hands — hence the same limit on chain, where a
compromised key cannot ignore it.

**Still not bounded by** anything that makes the loss *recoverable*. A cap
chooses the size of the hole; it does not fill it.

**Removed by.** Proving Mina state on Flare (§6.3) — for which the Pickles
verifier already exists and is measured, so what remains is wiring rather than
research.

### GAP 2 — The withdrawal attestor can release escrow

The mirror image, on the Mina side. Bounded the same way: it signs a
`WithdrawalRecord` whose hash covers nonce, recipient and amount, and cannot
exceed `lockedNanomina` or go backwards in nonce.

**Removed by.** Verifying the Flare Relay signing policy inside a Pickles
circuit — FDC attestation of the burn, ECDSA set, weight threshold. This is the
*tractable* direction: we measured one ECDSA verification inside a zkApp at
**31,810 constraints**, so a signing policy is a circuit that fits, not a
research problem. The state field exists specifically so that removing it is a
visible diff.

### GAP 3 — `MockSettlementVerifier` accepts any proof

It exists so the frontend, relayer and tests can exercise the full batch flow
before the SP1 pipeline is wired in. It accepts anything, so anyone can mint.

**Mitigated by.** `isMockVerifier()` returns true; the deploy script refuses to
use it outside a local or test chain; rotation is timelocked and emits an event.
The escape hatch is loud on purpose.

**Removed by.** §6.3.

### GAP 4 — Field signatures carry no network separation

`mina-signer` 4.1.0 hardcodes the devnet domain in `signFields` regardless of the
configured network. So a field signature does not distinguish Mina mainnet from
devnet. We do not rely on it: separation comes from `chainId` inside the signed
message and from the purpose tag. This is recorded because a future reader might
otherwise assume the `mainnet` flag is doing work it is not.

### GAP 5 — Someone must pay gas

A Mina key can authorise but cannot pay. Some EVM account must submit. It need
not be trusted — see §2 — but it must exist. Reimbursing the submitter out of the
account's own FMINA balance removes the last reason for a Mina user to hold an
EVM account, and makes censorship economically pointless rather than merely
useless.

---

## 6. Hardening plan

Ordered by ratio of risk removed to work required, not by ambition.

### 6.1 On-chain mint ceilings — closes part of GAP 1

Put the attestor's per-deposit ceiling where a compromised key cannot ignore it,
and add a cumulative one.

- `maxAttestedDepositNanomina` — refuse any single signature-path mint above it.
- `attestedMintCapNanomina` — refuse once cumulative signature-path minting
  crosses it. A per-deposit ceiling alone only forces an attacker to loop.

Both are set at construction (10,000 and 100,000 MINA), so a bridge is never
live with an unlimited signature path — an unset ceiling would default to the
exact exposure the ceiling exists to remove.

`attestedMintedNanomina` never decreases, in particular not on `burnToMina`. The
cap bounds how much the attestor key can *ever* have been worth; a round trip
through the bridge is not evidence that the key stayed honest, and letting it
refill the allowance would make the cap a rate limit rather than a bound.

Changing the ceilings is deliberately asymmetric:

| Direction | Delay | Why |
|---|---|---|
| Lower | Immediate | Reacting to a suspected compromise within one block is the whole point |
| Raise | `VERIFIER_UPDATE_DELAY` (2 days) | It increases how much unbacked supply a trusted key could produce; holders are entitled to a window in which to exit |

That asymmetry buys a second property worth naming, because the owner is not
otherwise constrained here: attestor rotation is instant, so an attacker holding
the **owner** key can mint — but only up to the ceiling in force today, never one
they set themselves.

This does not make the attestor trustless. Nothing on this path does. It converts
an unbounded loss into a bounded one that the operator chose.

Status: **implemented** — `MinaPortBridge.sol`, and six tests in
`MinaSignatureDeposit.t.sol` covering both ceilings, the refill property, and
both directions of the timelock.

### 6.2 Monitoring the invariant

`collateralInvariantHolds()` is checked in tests but nothing watches it in
production. A watcher that compares `totalSupply(FMINA)` against the escrow
zkApp's `lockedNanomina` every block, and pauses on divergence, turns GAP 1 and
GAP 2 from silent into loud. Cheap, and independent of every cryptographic
improvement below.

### 6.3 Proving Mina state on Flare — closes GAP 1 and GAP 3

This is the real fix. It is normally where a bridge design says "future work",
and the honest reason it does not here is that **the hard part already exists and
is measured**: a universal Mina Pickles verifier running inside a zkVM,
verifying a real Mina *mainnet* blockchain SNARK.

**Where the cost is.** Mina's proof system is Pickles over Kimchi on the Pasta
cycle, so verifying it means arithmetic in the Pallas and Vesta base fields. No
zkVM ships a Pallas precompile — SP1's cover secp256k1, ed25519, bn254 and
bls12-381 — so on a generic RISC-V target every Pasta point operation is
software. That is ~95% of the guest's work.

**[o1js-to-zkvm](https://github.com/youtpout/o1js-to-zkvm) — SP1.** Universal
Pickles verifier, settling any o1js proof through a single Solidity deployment.
Measured at **4,378,867,074 cycles** for one mainnet blockchain SNARK.

**[o1-openvm](https://github.com/youtpout/o1-openvm) — OpenVM.** The same
verifier core, same input bytes, on OpenVM with both Pasta curves declared as
first-class curves (`moduli_declare!` + `sw_declare!` in `mina-curves`, wired
through the modular and ECC chips via `openvm.toml`). The point OpenVM's docs
obscure by listing K256 and P256: the ECC extension takes an arbitrary
`(modulus, scalar, a, b)`, and Pallas and Vesta are both `a = 0, b = 5`.

| configuration | instructions | trace cells | vs unaccelerated |
|---|---|---|---|
| no chips | 31,819,681,513 | 1,170,322,141,177 | — |
| + modular (Fp/Fq) | 24,221,887,063 | 896,055,841,422 | ×1.31 |
| + Vesta | 5,815,088,237 | 220,926,602,404 | ×5.47 |
| + Pallas | 2,249,380,517 | 86,644,291,990 | ×14.15 |
| + VK validation, no heap allocs | 2,230,979,102 | 85,934,163,225 | ×14.26 |
| **+ OpenVM 2.1 / rv64** | **898,656,552** | **32,057,167,004** | **×35.41** |

Two results from that table are worth carrying into any similar work. The
modular chip *alone* buys almost nothing (×1.31) — accelerating field
multiplication underneath software curve arithmetic cannot pay when the cycles
are in point operations. And adding curve validation on the 28 VK commitments
came out **−2.45% instructions**, because the same change removed a `Vec`
allocation per coordinate: security at negative cost.

OpenVM ends up ~4.87× below the SP1 figure, but that comparison should be
treated as indicative only — an SP1 cycle and an OpenVM instruction are not the
same unit, and SP1 exposes no trace-cell count, which is the number that actually
tracks proving cost. The comparison worth trusting is rv32-vs-rv64 *within*
OpenVM, where both metrics exist and agree (×2.48 and ×2.68).

**What this changes for the bridge.** GAP 1 and GAP 3 are no longer blocked on
whether Pickles verification in a zkVM is feasible. Three things remain, none of
them research:

1. **The statement.** The guest reveals
   `keccak256(abi.encode(bytes32 vkHash, bytes32[] statement))` — 32 bytes, with
   the consumer supplying the preimage. `IMinaSettlementVerifier` already consumes
   `SettlementPublicValues`; binding `depositsRoot`, `previousActionState` and
   `newActionState` into that statement is an encoding decision, and the encoding
   discipline for exactly this already exists in `packages/shared`.
2. **The on-chain verifier.** The OpenVM Solidity SDK verifies a Halo2/KZG proof
   on any EVM chain for **under 330k gas** — *less than the 809k we already pay
   for one Schnorr verification*. Implementing `IMinaSettlementVerifier` against
   it retires `MockSettlementVerifier` through the existing timelocked rotation,
   which is what that timelock was built for.
3. **Proving cost.** ~900M instructions is the binding constraint, not gas. This
   is why settlement is batched: the cost is per *batch*, not per deposit.

The guest panics rather than revealing a validity flag, so a proof exists only
for accepted inputs and a consumer cannot forget to check a boolean — the same
discipline `packages/prover`'s SP1 guest follows, for the same reason.

Both routes are tracked in `packages/prover`, which is deliberately off the MVP
path: on Flare, direct verification is cheaper in every dimension that matters —
no relayer, no proving artifacts, no multi-minute wait, no trusted setup.

### 6.4 FDC-verified return path — closes GAP 2

Request an `EVMTransaction` attestation of the burn, verify the Relay signing
policy and Merkle proof inside a Pickles circuit, drop `withdrawalAttestor`.
Sized at 31,810 constraints per ECDSA verification (measured), so the circuit
fits. Independent of §6.3 and cheaper — this direction needs signature
verification, not recursive proof verification.

### 6.5 Submitter reimbursement — closes GAP 5

Pay the submitter out of the account's FMINA balance, inside the same batch.

---

## 7. What this document does not cover

- **Economic attacks on the DEXes** a `MinaAccount` trades against. The account
  deliberately knows nothing about DeFi — that is why it works with every DEX and
  needs no allowlist — and it therefore offers no protection against a bad swap.
  Slippage is the caller's business.
- **Key management** by users on either chain.
- **Front-running of swaps.** Batching helps by making approve-and-swap atomic,
  but it does not address MEV.
- **Availability of Mina or Flare.** A halted chain strands in-flight transfers
  in both directions.

## Sources

- [o1-openvm](https://github.com/youtpout/o1-openvm) — universal Pickles verifier on OpenVM; the measurements in §6.3 are from its working notes
- [o1js-to-zkvm](https://github.com/youtpout/o1js-to-zkvm) — the same verifier core on SP1
- [OpenVM Book — custom extensions](https://book.openvm.dev/custom-extensions/overview.html)
- [Releasing the OpenVM Solidity SDK](https://blog.openvm.dev/solidity-sdk) — Halo2/KZG proofs verified on any EVM chain under 330k gas
- [Succinct — optimized bn254 & bls12-381 precompiles in SP1](https://blog.succinct.xyz/succinctshipsprecompiles/)
