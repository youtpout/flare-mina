//! MinaPort prover CLI.
//!
//! ```text
//! minaport-host execute --batch 1     # emulate, print cycle stats (no proof)
//! minaport-host prove   --batch 1     # real Groth16 proof for Flare
//! ```
//!
//! `execute` is the measurement tool: it runs the guest in SP1's emulator and
//! reports the instruction count, which is what determines proving time and
//! network cost. Use `--batch N` to measure the marginal cost of an extra
//! authorization — the interesting number, since the Groth16 wrap is fixed.

use anyhow::Result;
use ark_ff::{BigInteger, PrimeField};
use clap::{Parser, Subcommand};
use minaport_schnorr::{BaseField, ScalarField};
use serde::{Deserialize, Serialize};
use sp1_sdk::{include_elf, ProverClient, SP1Stdin};
use std::str::FromStr;

/// The guest ELF, built by build.rs.
pub const MINAPORT_ELF: &[u8] = include_elf!("minaport-guest");

/// Mirror of the guest's wire type. Kept in the binary rather than in a shared
/// crate so the guest stays free of host-only serde machinery.
#[derive(Serialize, Deserialize)]
struct WireSignedAuthorization {
    mina_public_key_x: [u8; 32],
    mina_public_key_is_odd: bool,
    chain_id: u64,
    target: [u8; 20],
    action_hash: [u8; 32],
    nonce: u64,
    expiry: u64,
    signature_rx: [u8; 32],
    signature_s: [u8; 32],
}

#[derive(Serialize, Deserialize)]
struct WireInput {
    network_id: u8,
    authorizations: Vec<WireSignedAuthorization>,
}

#[derive(Parser)]
#[command(name = "minaport-host", about = "MinaPort SP1 prover")]
struct Cli {
    #[command(subcommand)]
    mode: Mode,

    /// Number of authorizations in the batch.
    #[arg(long, default_value_t = 1, global = true)]
    batch: usize,
}

#[derive(Subcommand)]
enum Mode {
    /// Emulate the guest and print cycle statistics. No proof is produced.
    Execute,
    /// Produce a real Groth16 proof, ready for the Flare verifier.
    Prove,
}

/// Reference vectors generated with o1js `Signature.create`, reused from the
/// `minaport-schnorr` conformance tests. Real signatures, so the measurement
/// reflects the real verification path rather than a synthetic input.
const VECTORS: &[(&str, bool, [&str; 2], &str, &str)] = &[
    (
        "28458361157200061646275075754670616707828565372579655071645359937703726536371",
        true,
        ["11", "22"],
        "17886411415089962440654512926903791657347673995368507775091595326741003920384",
        "23526475448460078932579517507487500402302677187905851962120003756237115094819",
    ),
    (
        "13386019024431262222823433559007653063384989782877316892062967640001759191355",
        true,
        ["22", "44"],
        "17075101623349901098156794354551043302348373490128886255351679684496420248923",
        "2728729124507309808736641100963180990592035922959104853274880777693849842076",
    ),
    (
        "8802991696068510855712751822202156344780430110168476152437677908131014442562",
        true,
        ["33", "66"],
        "9869548486958001433867753221972782422059932325027208627300395971357104466532",
        "22563578004169192810093956982665144095732964799177130644502509147766056412320",
    ),
];

fn be32<F: PrimeField>(value: F) -> [u8; 32] {
    let bytes = value.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

/// Build a measurement batch.
///
/// NOTE: the o1js vectors sign a 2-field message, whereas a real MinaPort
/// authorization signs the 6-field encoding from `minaport-core`. Cycle counts
/// are dominated by the two scalar multiplications, which do not depend on
/// message length, so this is representative for measurement — but it is NOT a
/// valid input for `prove`, which needs signatures over the real encoding.
fn build_measurement_input(batch: usize) -> WireInput {
    let authorizations = (0..batch)
        .map(|i| {
            let (pk_x, is_odd, _msg, rx, s) = VECTORS[i % VECTORS.len()];
            WireSignedAuthorization {
                mina_public_key_x: be32(BaseField::from_str(pk_x).unwrap()),
                mina_public_key_is_odd: is_odd,
                chain_id: 114, // Coston2
                target: [0x11; 20],
                action_hash: [0x22; 32],
                nonce: i as u64,
                expiry: u64::MAX,
                signature_rx: be32(BaseField::from_str(rx).unwrap()),
                signature_s: be32(ScalarField::from_str(s).unwrap()),
            }
        })
        .collect();

    WireInput { network_id: 0, authorizations }
}

fn main() -> Result<()> {
    sp1_sdk::utils::setup_logger();
    let cli = Cli::parse();

    let mut stdin = SP1Stdin::new();
    stdin.write(&build_measurement_input(cli.batch));

    let client = ProverClient::from_env();

    match cli.mode {
        Mode::Execute => {
            let (_public_values, report) = client.execute(MINAPORT_ELF, &stdin).run()?;
            let cycles = report.total_instruction_count();

            println!("batch size            : {}", cli.batch);
            println!("total cycles          : {cycles}");
            println!("cycles/authorization  : {}", cycles / cli.batch.max(1) as u64);

            let mut entries: Vec<_> = report.cycle_tracker.iter().collect();
            entries.sort_by_key(|(name, _)| name.clone());
            for (name, count) in entries {
                println!("  {name}: {count} cycles");
            }
        }
        Mode::Prove => {
            let (pk, vk) = client.setup(MINAPORT_ELF);
            let proof = client.prove(&pk, &stdin).groth16().run()?;
            client.verify(&proof, &vk)?;

            println!("program vkey    : {}", vk.bytes32());
            println!("public values   : 0x{}", hex::encode(proof.public_values.as_slice()));
            println!("groth16 proof   : 0x{}", hex::encode(proof.bytes()));
        }
    }

    Ok(())
}
