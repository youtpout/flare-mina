# The trust-minimised return path

How a burn on Flare becomes a release on Mina without anyone being trusted to
say it happened. This is the design that replaces `withdrawalAttestor`
(GAP 2 in [threat-model.md](./threat-model.md)).

## The problem in one number

Mina and the EVM disagree about which hash is cheap. Measured in o1js, against
a 65,536-row domain:

| operation | rows |
|---|---|
| Poseidon over two fields | 13 |
| `IndexedMerkleMap` height 33 — full inclusion, root bound | **514** |
| one keccak256 over 64 bytes | **14,636** |

A keccak Merkle path is ~14.6k rows *per level*. Four levels is all that fits
in one proof, so a 32-level path costs eight recursive proofs. The same path
over Poseidon costs 514 rows *in total*, for a tree of four billion leaves.

So the design principle is not "avoid keccak" — it is **pay keccak once per
root, never once per withdrawal**.

## The chain

```
Solidity            withdrawals accumulate under a keccak commitment
                    (cheap on an EVM, and the EVM is where they happen)
      │
SP1 guest           reads the withdrawal list, checks it against the keccak
                    commitment, rebuilds the o1js IndexedMerkleMap,
                    commits { keccakAcc, poseidonRoot }
      │
Flare bridge        ISP1Verifier.verifyProof(...)
                    require(pv.keccakAcc == storedKeccakAcc)
                    store pv.poseidonRoot
      │
FDC                 EVMTransaction attestation of that store, folded into the
                    voting round's Merkle tree
      │
Relay               the signing policy signs the round root
      │
Mina  publishFlareRoot   SigningPolicyFold: enough validator weight signed the
                         round root, + inclusion of our attestation in it
      │
Mina  releaseWithdrawal  IndexedMerkleMap inclusion against the stored root
                         — Poseidon, 514 rows
```

## Why SP1 is in the picture at all

Not to carry anything to Mina. **Mina never sees the SP1 proof**: it is Groth16
over BN254, and verifying a pairing in a Kimchi circuit over Pallas is not a
cost problem, it is a different-arithmetic problem. The proof is verified on
Flare, where a precompile makes it trivial.

SP1's only job is to compute a Poseidon-Pallas root that Solidity does not want
to pay for. An `IndexedMerkleMap` insertion at height 33 recomputes two paths,
~64 permutations; in Solidity that is plausibly 2–4 M gas per withdrawal —
an estimate, not a measurement, and the one worth taking before building the
guest. If it fits comfortably in a Flare block, the zkVM disappears from this
diagram and Solidity maintains the map directly.

`~/Projects/zkdex/sp1` already has this shape: a guest that commits a
Poseidon-Mina root, bound by an EVM verifier. Its Poseidon-Pallas
implementation — the part that must agree with o1js bit for bit — is reusable
as-is.

## Where keccak survives

The signing policy does not sign our bridge's storage. It signs **FDC voting
round roots**. Getting our Poseidon root under a validator signature therefore
means requesting an `EVMTransaction` attestation of the transaction that stored
it, and proving on Mina that our attestation is a leaf of that round's tree —
which is a keccak tree.

That path is short (round trees hold one attestation per request, not one per
withdrawal) and it is walked **once per published root**, amortised over every
withdrawal that root covers. But it is not zero, and it is why
`MerkleInclusion.ts` is still needed: what the Poseidon map removes is the
*per-withdrawal* keccak path, not this one.

## What does not get fixed by any of this

**Double release.** Proving a withdrawal is in the tree does not prove it has
not already been paid. Mina still needs `lastWithdrawalNonce` or a spent-set,
which is read-modify-write, which serialises releases to one per block.
Deposits stay concurrent because they read no state; withdrawals cannot.

**Signer binding.** `SigningPolicyFold` proves *n* valid ECDSA signatures at
distinct ascending indices. Nothing yet constrains those signers to belong to
the policy they name — see the header of `SigningPolicyFold.ts`. That gap is
independent of everything above and must close before the attestor is removed.
