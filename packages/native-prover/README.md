# native-prover

Proves a bridge deposit **in Rust, with no o1js at run time**.

Every proving figure elsewhere in this repository goes through o1js — either its
js_of_ocaml prover or the Rust one behind `setBackend('native')`. Both still pay
for a Node process, the JS/native boundary, and o1js's own bookkeeping on each
call. This package removes all of it, so the number it reports is the cost of
the proof and nothing else.

The answer decides something concrete: whether the relayer's proving worker can
stay in Node, or whether it is worth running a separate Rust service.

## How it works

o1js runs **exactly once**, at export time:

```
tools/exportProgram.mjs      assets/bridge-program.json        src/bench.rs
──────────────────────       ─────────────────────────         ────────────
compile MinaPortBridge   →   3 recorded branches           →   compile
run one real deposit     →   deposit branch index              verify VK  ← gate
capture the witness      →   9,310 solved witness values   →   prove ×6
                             o1js's own VK hash + timings
```

The recordings arrive through `__rustPicklesRecordingObserver`, a hook the o1js
fork calls for every circuit it records; it is a no-op when unset.

The asset is committed, so `npm run bench` needs neither Node nor o1js — only a
Rust toolchain.

## Result

Measured on `deposit` (744 rows, Pickles domain 1024), macOS arm64, 10 cores.
Warm figures are the steady state over six consecutive proofs.

| prover | prove (warm) |
|---|---|
| o1js, wasm | 13.5 – 14.1 s |
| o1js + `@o1js/native` | 8.1 – 8.8 s |
| **this crate, no o1js** | **7.7 – 8.3 s** |
| o1js + `pickle-rust` fork, rust backend | 6.5 – 7.4 s |

**Leaving Node buys nothing.** Pure Rust lands on the same figure as the
official native backend, so the JS harness is not the bottleneck — consistent
with the 0.1 s spent building the transaction against ~8 s spent proving. The
relayer's proving worker therefore stays in Node: no separate Rust service, no
FFI to maintain.

The number that does move is `compile`, and only via the cache: 10.5 s here
with `cache_bytes_base64: None`, against 1.8 s for a cached o1js compile. A
production build would embed a cache payload the way `mina-fungible-token`
does.

VK parity holds against the **official** o1js too, not just the fork:

```
o1js (jsoo)   10744482038006661563777008707923128791257963680680722742783152959747527691514
this crate    10744482038006661563777008707923128791257963680680722742783152959747527691514
```

## The verification key is a gate, not a metric

A prover that is fast and produces a different verification key is worthless:
the zkApp deployed on devnet accepts exactly one key. So `bench.rs` compares the
VK it compiles against the one o1js reported at export time and **fails** on a
mismatch. Timings are only printed once that holds.

## Running it

```bash
cargo run --release --bin bench
```

The first build compiles the whole `proof-systems` + `mina-rust` stack and takes
tens of minutes; later ones are incremental.

`Cargo.lock` is committed and must stay that way: a fresh resolution picks
`core2 0.4.0`, which is yanked, and fails. Cargo accepts it from a lockfile.

## Regenerating the asset

Only needed when the contract's circuits change:

```bash
node tools/exportProgram.mjs
```

This step — and only this step — needs the o1js
[`pickle-rust`](https://github.com/youtpout/o1js/tree/pickle-rust) fork resolved
as `o1js`, plus its `@o1js/mina-runtime-<platform>-<arch>` addon, because
`setProofSystemBackend('rust')` and the recording hook exist only there. The
rest of the repository deliberately uses the **official** o1js with
`@o1js/native`.

Build the addon with, from the fork:

```bash
MINA_RUST_ROOT=/path/to/mina-rust npm run build:rust-backend
```

## Prior art

The structure follows the mobile prover in
[`mina-fungible-token`](https://github.com/youtpout/mina-fungible-token) —
package the recorded program once, embed it, prove natively — which is where the
approach and the VK-parity gate come from.
