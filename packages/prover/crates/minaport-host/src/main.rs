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
use sp1_sdk::{include_elf, Elf, Prover, ProverClient, ProvingKey, SP1Stdin};
use std::str::FromStr;

/// The guest ELF, built by build.rs.
const ELF: Elf = include_elf!("minaport-guest");

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

/// Reference vectors generated with o1js, signing the REAL 6-field authorization
/// encoding produced by `Authorization::to_fields` — chainId 114, target
/// 0x1111..11, actionHash 0x2222..22, nonce = index, expiry = u64::MAX.
///
/// Signing the actual encoding matters: an earlier version reused vectors over a
/// 2-field message, which exercised the full cryptographic path but always failed
/// the final comparison, so `verify_batch` returned on the first item and batch
/// measurements were meaningless.
const AUTH_VECTORS: &[(&str, bool, &str, &str)] = &[
    ("27248019216674574326920953522382257010852734487616232843989705403631268775799", true, "9799159612639622203408738272017529237977234308545151025846068183682436594810", "21432720625313902137887510388052434438006328676485519577320821182333483769574"),
    ("23973937293986976186026549359865136156061261246966353816445489793064586048438", true, "17378431964284951092827086574986400748961197075007852908382849418828443212595", "16021649426238287773927608865070238213101668519137395661951274814181487605677"),
    ("26916244958417249619518109435048865098320997836305044395470375345859438779142", false, "2183091523530775261645214008402841053708029409039645041768302742027229317825", "14195286456458775965479274611788967382947206567894000646518552688522009573945"),
    ("18401137998991848832671251767882463401721195599567362779407124493373243066473", true, "5057127165108410098497815551981498175754171583229896623010967286331268469489", "380862350998454409877254806960167828130129059770069138762827779127983462879"),
    ("19986527813018408765666982569220062384608904711978121983637410348586581916676", false, "3231094110142372968595509228721496628373518763967173731902593500605023615273", "5696543264053926415422711657985558474556844373135884511826795783848797835364"),
    ("945272258804781895587540697903252832800436822338251865539210447240825181071", true, "25510056859785647858967450651174040072228560807076982431679375628637682497040", "3153777799369301196341923489933637130391082140661658760605788532353701735600"),
    ("18039375003445784860924845080151669363974310466631775831918510568767955031060", true, "25373935434110458066523932992093725517526454129523592992706041771837338192519", "5598677132441933635668596008648226210273337094258030136869681519739103439172"),
    ("17915756863341731646097817978917846811962966642696088517236915660443080531572", true, "10231779971118742155712168064821068564887949345198890858105500605397109801814", "6512982686954205965516105289795227324494779408463587845309533852442849304520"),
    ("8568229007087287036243174467420345173578256410458399653678478586243664337088", true, "4639494615804375792286853436842423312490243206333650799148171321075711737797", "12257927356964707137249201063996598247653535798032580451453114452883229467897"),
    ("28217914063935222397898566289795704600767317676930722732167659368881588125284", true, "4605436902187333671836467932626064829372954299754125197083474533639786547317", "6889374252028127834958162690671294835478161205849613049239531023840857437791"),
    ("21051360844536436969224092196166259956830310295223768560366622807079632532985", false, "3443455976085767740935061058119562604495649513075632070918379773394596459975", "5431152611923453231249475199135747504476662089840079741535189484008134077658"),
    ("14260152092395978000198163900204580464247085419910292634059453862670685576157", true, "3073934693596512072397954254197848468290875530755534623090848856199973555480", "19527614390789868106359236816881714063219660102798794017131318745948932484409"),
    ("403848732697411273245552226843612006347744000417477081561233308117095747817", true, "23223882535937321988946865848211700078347741753817343610128639708482469624368", "17052596936982407611615660014430361062296240883314282321669380280976772146134"),
    ("7733292547184991120330716479576999869883536000973693853928843957819865230190", false, "18156250847826774000289666613896108555904683689075533507998735126922746524235", "8340311907624132377329685368962154958854460669774430636691980682882225586847"),
    ("2567654451917299768787954555608618618877809708813340937082599522416704014264", true, "1914298151848702874671349796045376708639296436453389611786899007112207399405", "248160790943265614835210894875048427065826486221117471700913350279355904743"),
    ("459791183912223677847620286374567150358791543083262312627519165387018368995", true, "6208177626684705872932917114805833747945537395051731767052618473618550088378", "9182078430533802268134484851672183159904466678783190942799093581662367546032"),
];

fn be32<F: PrimeField>(value: F) -> [u8; 32] {
    let bytes = value.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

/// Build a measurement batch of genuinely valid authorizations.
///
/// The vectors sign the real 6-field encoding, so every signature verifies and
/// the whole batch is processed — which is what makes the per-authorization
/// marginal cost meaningful.
fn build_measurement_input(batch: usize) -> WireInput {
    let authorizations = (0..batch)
        .map(|i| {
            let (pk_x, is_odd, rx, s) = AUTH_VECTORS[i % AUTH_VECTORS.len()];
            WireSignedAuthorization {
                mina_public_key_x: be32(BaseField::from_str(pk_x).unwrap()),
                mina_public_key_is_odd: is_odd,
                chain_id: 114, // Coston2
                target: [0x11; 20],
                action_hash: [0x22; 32],
                nonce: (i % AUTH_VECTORS.len()) as u64,
                expiry: u64::MAX,
                signature_rx: be32(BaseField::from_str(rx).unwrap()),
                signature_s: be32(ScalarField::from_str(s).unwrap()),
            }
        })
        .collect();

    WireInput { network_id: 0, authorizations }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    let mut stdin = SP1Stdin::new();
    stdin.write(&build_measurement_input(cli.batch));

    let client = ProverClient::builder().cpu().build().await;

    match cli.mode {
        Mode::Execute => {
            let (_public_values, report) = client.execute(ELF, stdin).await?;
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
            let pk = client.setup(ELF).await?;
            let proof = client.prove(&pk, stdin).await?;
            client.verify(&proof, pk.verifying_key(), None)?;

            println!("public values   : 0x{}", hex::encode(proof.public_values.as_slice()));
            println!("groth16 proof   : 0x{}", hex::encode(proof.bytes()));
        }
    }

    Ok(())
}
