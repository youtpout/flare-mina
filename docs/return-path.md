# The trust-minimised return path

How a burn on Flare becomes a release on Mina without anyone being trusted to
say it happened. This is the design that replaces `withdrawalAttestor`
(GAP 2 in [threat-model.md](./threat-model.md)).

## The chain

```
Flare     the user signs a bridge-specific withdrawal intent with their Mina
          wallet; Solidity verifies the Schnorr signature, checks the balance,
          burns the FMINA, and emits a minimal event

FDC       an EVMTransaction attestation of that transaction becomes one leaf of
          the voting round's Merkle tree

Relay     the signing policy signs the round root, stored in
          `merkleRoots[roundId % 6720]` under protocol 200

Mina      publishFlareRoot   SigningPolicyFold: enough validator weight signed
                             the round root
          claim              MerkleInclusion: a path from our leaf to that root
```

Every step is verified by the chain that finds it cheap. Flare checks a Pallas
Schnorr signature, because its base field fits one EVM word. Mina checks
secp256k1 signatures and keccak, because it has no alternative — but only once
per round, amortised over every withdrawal that round carries.

## What it costs

Measured in o1js, against a 65,536-row domain:

| operation | rows |
|---|---|
| Mina Schnorr verify, 4-field message | 349 |
| `MerkleInclusion.merge` | 328 |
| `MerkleInclusion.level` — one keccak pair | 14,733 |
| `SigningPolicyFold.merge` | 185 |
| `SigningPolicyFold.single` — one secp256k1 verify | 31,814 |
| keccak256 over 512 bytes | 59,675 |

Both expensive operations exceed a third of the domain, so recursion is not a
choice — a *second* signature or a *second* keccak already does not fit
alongside the first. Both programs are therefore merge trees: leaves are
independent and prove in parallel, and depth costs log(n) merges rather than n
sequential steps.

The last row is the one to design against. Keccak's rate is 136 bytes, so cost
steps by block: 64 and 128 bytes both cost one permutation, 512 bytes costs
four. **Attest the smallest possible event** — `(nonce, minaRecipient, amount)`
and nothing else. The Mina signature does not belong in the leaf: Flare would
not have emitted the event without it.

## Why there is no SP1 in this diagram

There was, in an earlier draft. The idea was to have a zkVM guest rebuild the
withdrawal set as an o1js `IndexedMerkleMap` — Poseidon costs 13 rows against
keccak's 14,636 — so Mina would verify a Poseidon path instead of a keccak one,
and pay 514 rows for a 32-level inclusion.

It works, and `~/Projects/ethereum-settlement` shows the pattern in production
for Zeko: the guest computes both hash worlds and proves they describe the same
batch. But it buys a per-withdrawal saving at the cost of a guest, a
Poseidon-Pallas implementation that must agree with o1js bit for bit, and an SP1
verifier deployment — and Mina cannot verify the SP1 proof anyway (Groth16 over
BN254 is not Kimchi over Pallas), so it never removed the FDC step it was meant
to replace. Proving inclusion directly against the round root is strictly
simpler and needs nothing that is not already built.

## What a Mina signature can and cannot do

It authorises: which recipient, which amount, which nonce, and only the holder
of that Mina key can produce it. Bound to a per-user nonce it also cannot be
replayed, and a stuck withdrawal strands only its own signer rather than
everyone behind it — unlike today's single global `lastWithdrawalNonce`.

It cannot attest. A signature observes nothing, so nothing in it distinguishes
*submitted to Flare, balance checked, FMINA burned* from *signed and pocketed*.
A user could sign, never submit, and claim on Mina while keeping their FMINA.
Only an artifact authenticated by Flare itself — validator signatures, or a
proof — closes that, which is exactly what the FDC path above provides.

## What is still open

**Signer binding.** `SigningPolicyFold` proves *n* valid ECDSA signatures at
distinct ascending indices. Nothing yet constrains those signers to belong to
the policy they name — see the header of `SigningPolicyFold.ts`. This must
close before the attestor is removed.

**Double release.** Proving a withdrawal is in a round root does not prove it
has not already been paid. Mina still needs a spent-set or a nonce, which is
read-modify-write, which serialises releases to one per block. Deposits stay
concurrent because they read no state; withdrawals cannot.

**Round root storage.** `flareRoot` holds one root. Rounds are 90 seconds, so
the zkApp needs a set of accepted roots rather than the latest one.
