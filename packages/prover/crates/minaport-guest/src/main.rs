//! SP1 guest: verify a batch of Mina-signed authorizations.
//!
//! ```text
//! in   : network id, and N (authorization, Mina Schnorr signature) pairs
//! out  : abi.encode(MinaAuthorization[])   -- committed as SP1 public values
//!        ...or no proof at all, if any signature fails
//! ```
//!
//! # Why a batch
//!
//! The dominant cost of an SP1 proof is not execution — it is the fixed
//! recursion + Groth16 wrap that turns the STARK into something a Solidity
//! verifier can check. That cost does not depend on how much the guest did.
//! Verifying one signature and verifying two hundred therefore cost almost the
//! same wall-clock time, so the batch is the natural unit and a single-item
//! batch is just the degenerate case.
//!
//! # Why there is no `valid` flag
//!
//! A boolean in the public values would be a footgun: a consumer who forgot to
//! check it would accept everything. Instead the guest panics on the first
//! invalid signature, so an SP1 proof only exists for a fully verified batch.
//! Contracts still MUST check `chainId`, `target`, `nonce` and `expiry` — the
//! proof attests that the Mina key signed, not that the action is currently
//! appropriate.

#![no_main]

use alloy_sol_types::SolValue;
use minaport_core::{verify_batch, Authorization, SignedAuthorization};
use minaport_schnorr::{BaseField, NetworkId, PublicKey, ScalarField, Signature};

sp1_zkvm::entrypoint!(main);

/// Wire form of one signed authorization.
///
/// Field elements travel as canonical big-endian bytes rather than as arkworks
/// types so the host can serialise without pulling in the curve crates' serde,
/// and so the encoding is inspectable in fixtures.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct WireSignedAuthorization {
    pub mina_public_key_x: [u8; 32],
    pub mina_public_key_is_odd: bool,
    pub chain_id: u64,
    pub target: [u8; 20],
    pub action_hash: [u8; 32],
    pub nonce: u64,
    pub expiry: u64,
    pub signature_rx: [u8; 32],
    pub signature_s: [u8; 32],
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct WireInput {
    /// 0 = testnet/devnet, 1 = mainnet.
    pub network_id: u8,
    pub authorizations: Vec<WireSignedAuthorization>,
}

pub fn main() {
    let input: WireInput = sp1_zkvm::io::read();

    let network = match input.network_id {
        0 => NetworkId::Testnet,
        1 => NetworkId::Mainnet,
        other => panic!("unknown Mina network id: {other}"),
    };

    let batch: Vec<SignedAuthorization> = input
        .authorizations
        .iter()
        .map(|wire| SignedAuthorization {
            authorization: Authorization {
                mina_public_key: PublicKey {
                    x: field_from_be(&wire.mina_public_key_x),
                    is_odd: wire.mina_public_key_is_odd,
                },
                chain_id: wire.chain_id,
                target: wire.target,
                action_hash: wire.action_hash,
                nonce: wire.nonce,
                expiry: wire.expiry,
            },
            signature: Signature {
                rx: field_from_be(&wire.signature_rx),
                s: scalar_from_be(&wire.signature_s),
            },
        })
        .collect();

    // Panics — and therefore produces no proof — if any signature is invalid.
    let verified = match verify_batch(&batch, network) {
        Ok(verified) => verified,
        Err((index, error)) => panic!("authorization {index} failed verification: {error:?}"),
    };

    sp1_zkvm::io::commit_slice(&verified.abi_encode());
}

/// Decode a base-field element from canonical big-endian bytes.
///
/// Rejects non-canonical input: a value at or above the modulus would otherwise
/// be silently reduced, letting two distinct byte strings denote the same field
/// element and breaking the binding between the wire form and what was signed.
fn field_from_be(bytes: &[u8; 32]) -> BaseField {
    use ark_ff::{BigInteger, PrimeField};
    let value = BaseField::from_be_bytes_mod_order(bytes);
    assert_eq!(
        value.into_bigint().to_bytes_be().as_slice(),
        bytes.as_slice(),
        "non-canonical base field encoding",
    );
    value
}

/// Same, for the scalar field.
fn scalar_from_be(bytes: &[u8; 32]) -> ScalarField {
    use ark_ff::{BigInteger, PrimeField};
    let value = ScalarField::from_be_bytes_mod_order(bytes);
    assert_eq!(
        value.into_bigint().to_bytes_be().as_slice(),
        bytes.as_slice(),
        "non-canonical scalar field encoding",
    );
    value
}
