//! Prove a bridge deposit in Rust, with no o1js anywhere in the loop.
//!
//! # Why this exists
//!
//! Every proving figure this project has measured so far went through o1js —
//! either its js_of_ocaml prover or the Rust one behind `setBackend('native')`.
//! Both still pay for a Node process, the JS/native boundary, and o1js's own
//! bookkeeping on each call. This binary removes all of it: it loads a program
//! o1js exported once, hands it to `mina-runtime`, and proves.
//!
//! What that isolates is the cost of the proof itself. If the number here
//! matches the o1js one, the harness is free and there is nothing to gain by
//! leaving Node. If it is materially lower, the difference is what a native
//! prover service would buy the relayer.
//!
//! # The verification key is the gate
//!
//! A prover that is fast and produces a different verification key is useless:
//! the zkApp deployed on devnet accepts one key. So the compiled VK hash is
//! compared against the one o1js reported at export time, and a mismatch is a
//! hard failure rather than a warning. Speed is only interesting once that
//! holds.
//!
//! Regenerate the input with:
//!   node packages/native-prover/tools/exportProgram.mjs

use std::{str::FromStr, time::Instant};

use ark_ff::PrimeField;
use mina_curves::pasta::Fp;
use mina_runtime::{Backend, CompileCircuitRequest, CompileProgramRequest, ProveCircuitRequest};
use pickles::recorded::RecordedCircuit;
use serde::Deserialize;

/// One circuit as the o1js fork records it.
#[derive(Clone, Deserialize)]
struct Recording {
    circuit: RecordedCircuit,
    witness: Vec<String>,
}

/// What `exportProgram.mjs` writes. Field names are the contract between the
/// two halves; a rename here without one there fails to parse rather than
/// proving something unintended.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackagedProgram {
    contract: String,
    /// The hash o1js computed for the same program. The gate.
    o1js_verification_key_hash: String,
    /// Index of `deposit` among the compiled branches.
    deposit_branch: usize,
    branches: Vec<Recording>,
    /// A solved witness for one real deposit, so proving needs no re-derivation.
    deposit_witness: Vec<String>,
    o1js_timings: O1jsTimings,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct O1jsTimings {
    compile_ms: u64,
    prove_ms: u64,
}

const PROGRAM_JSON: &str = include_str!("../assets/bridge-program.json");

/// How many proofs to time. The first is always slower — allocator and thread
/// pool warm-up — so it is reported apart from the steady state rather than
/// averaged into it, which would flatter or penalise depending on the count.
const RUNS: usize = 6;

fn main() -> Result<(), String> {
    let program: PackagedProgram =
        serde_json::from_str(PROGRAM_JSON).map_err(|e| format!("cannot decode the program: {e}"))?;

    println!("contract        : {}", program.contract);
    println!("branches        : {}", program.branches.len());
    println!("deposit branch  : {}", program.deposit_branch);
    println!("witness values  : {}", program.deposit_witness.len());
    println!(
        "o1js reference  : compile {:.1}s, prove {:.1}s",
        program.o1js_timings.compile_ms as f64 / 1000.0,
        program.o1js_timings.prove_ms as f64 / 1000.0
    );
    println!();

    let backend = Backend::default();

    // ---- compile -----------------------------------------------------------
    let started = Instant::now();
    let compiled = backend
        .compile_program(CompileProgramRequest {
            branches: program
                .branches
                .iter()
                .map(|recording| CompileCircuitRequest {
                    circuit: recording.circuit.clone(),
                    witness: recording.witness.clone(),
                    proofs_verified: 0,
                })
                .collect(),
            cache_bytes_base64: None,
            want_cache_bytes: false,
        })
        .map_err(|e| format!("compile failed: {e}"))?;
    let compile_ms = started.elapsed().as_millis();

    let branch = compiled
        .branches
        .get(program.deposit_branch)
        .ok_or_else(|| "the deposit branch is missing from the compiled program".to_owned())?;

    // ---- the gate ----------------------------------------------------------
    let expected = Fp::from_str(&program.o1js_verification_key_hash)
        .map_err(|_| "the exported verification key hash is not a field element".to_owned())?;
    let actual = branch
        .verification_key_hash
        .as_deref()
        .ok_or_else(|| "the native compiler returned no verification key".to_owned())?
        .parse::<Fp>()
        .map_err(|_| "the native compiler returned an invalid verification key".to_owned())?;
    if actual != expected {
        return Err(format!(
            "verification key mismatch — this prover would produce proofs the deployed \
             zkApp rejects.\n  o1js : {}\n  rust : {}",
            expected.into_bigint(),
            actual.into_bigint()
        ));
    }
    println!("compile         : {compile_ms} ms");
    println!("vk parity       : OK (identical to o1js)");
    println!();

    // ---- prove -------------------------------------------------------------
    let mut timings = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let started = Instant::now();
        backend
            .prove_circuit(ProveCircuitRequest {
                circuit_id: branch.circuit_id,
                witness: program.deposit_witness.clone(),
            })
            .map_err(|e| format!("prove failed: {e}"))?;
        timings.push(started.elapsed().as_millis());
    }

    let warm = &timings[1..];
    let min = warm.iter().min().copied().unwrap_or(0);
    let max = warm.iter().max().copied().unwrap_or(0);
    let avg = warm.iter().sum::<u128>() / warm.len() as u128;

    println!(
        "prove           : {}",
        timings
            .iter()
            .map(|ms| format!("{:.1}", *ms as f64 / 1000.0))
            .collect::<Vec<_>>()
            .join("  ")
    );
    println!(
        "  first {:.1}s | warm min {:.1} avg {:.1} max {:.1}s",
        timings[0] as f64 / 1000.0,
        min as f64 / 1000.0,
        avg as f64 / 1000.0,
        max as f64 / 1000.0
    );
    println!(
        "  vs o1js native: {:.2}x",
        program.o1js_timings.prove_ms as f64 / avg as f64
    );

    Ok(())
}
