//! Mina Schnorr signature verification, `no_std`, for zkVM guests.
//!
//! This is the cryptographic core of MinaPort's account-authorisation path. A
//! Mina wallet (MetaMask Snap) signs a payload; this crate verifies that
//! signature inside an SP1 guest; the resulting Groth16 proof is checked on
//! Flare. The Mina key therefore gains authority on Flare without ever
//! producing an ECDSA signature — which it cannot do, being a Pallas key.
//!
//! # The scheme
//!
//! A Mina signature is `(rx, s)` where `rx` is a base-field element and `s` a
//! scalar-field element. Verification is:
//!
//! ```text
//! e  = Poseidon(msg ‖ pk.x ‖ pk.y ‖ rx)   reinterpreted in the scalar field
//! R  = s·G − e·pk
//! accept iff R ≠ ∞ ∧ R.y is even ∧ R.x == rx
//! ```
//!
//! Matches `mina_signer::schnorr`'s `verify`, reimplemented here without that
//! crate's `std` dependencies (`Box`, `rand`, `thiserror`).
//!
//! # Network binding
//!
//! Mina's signing scheme seeds the sponge with a network-specific prefix, so a
//! signature made on devnet cannot be replayed as a mainnet signature. MinaPort
//! relies on that property, so [`NetworkId`] is a required argument rather than
//! a defaulted one.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::vec::Vec;

use ark_ec::{CurveGroup, PrimeGroup};
use ark_ff::{BigInteger, Field, PrimeField, Zero};
use mina_curves::pasta::{Fp, Fq, Pallas, ProjectivePallas};
use mina_poseidon::constants::PlonkSpongeConstantsKimchi;
use mina_poseidon::pasta::fp_kimchi;
use mina_poseidon::constants::SpongeConstants;
use mina_poseidon::poseidon::{ArithmeticSponge, Sponge};

/// Base field element (Pallas `Fp`) — coordinates and message fields.
pub type BaseField = Fp;
/// Scalar field element (Pallas `Fq`) — the signature scalar.
pub type ScalarField = Fq;

/// Mina network the signature is bound to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetworkId {
    /// Devnet / testnet.
    Testnet = 0x00,
    /// Mainnet.
    Mainnet = 0x01,
}

/// A Mina public key in its compressed curve-point form.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PublicKey {
    pub x: BaseField,
    pub is_odd: bool,
}

/// A Mina Schnorr signature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Signature {
    /// `R.x`, a base field element.
    pub rx: BaseField,
    /// The response scalar.
    pub s: ScalarField,
}

/// Why a verification failed. Useful in tests and host-side diagnostics; the
/// guest only branches on success.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerifyError {
    /// `pk.x` is not the x-coordinate of any point on Pallas.
    PublicKeyNotOnCurve,
    /// `s·G − e·pk` is the point at infinity.
    ResultAtInfinity,
    /// `R.y` was odd, or `R.x != rx`.
    SignatureMismatch,
}

impl PublicKey {
    /// Decompress `(x, is_odd)` into a curve point.
    ///
    /// Returns an error when `x³ + 5` is a non-residue, i.e. no Pallas point has
    /// this x-coordinate. Rejecting here matters: an off-curve "key" would place
    /// the whole verification in a group where the discrete log assumption does
    /// not hold.
    pub fn decompress(&self) -> Result<Pallas, VerifyError> {
        // Pallas: y² = x³ + 5
        let x = self.x;
        let y_squared = x * x * x + Fp::from(5u64);
        let y = y_squared.sqrt().ok_or(VerifyError::PublicKeyNotOnCurve)?;

        // `sqrt` returns an arbitrary root; select the requested parity.
        let y = if y.into_bigint().is_odd() == self.is_odd { y } else { -y };

        Ok(Pallas::new_unchecked(x, y))
    }
}

/// Longest domain prefix Mina accepts, and the width it pads to.
const MAX_DOMAIN_STRING_LEN: usize = 20;

impl NetworkId {
    /// Domain-separation string Mina seeds the signature sponge with.
    ///
    /// This — not an absorbed byte — is what makes a devnet signature invalid on
    /// mainnet: the two networks start the sponge from different states.
    const fn domain_string(self) -> &'static str {
        match self {
            Self::Mainnet => "MinaSignatureMainnet",
            Self::Testnet => "CodaSignature",
        }
    }
}

/// Convert a domain prefix into the field element Mina absorbs.
///
/// The prefix is right-padded with `*` to exactly 20 characters, then the ASCII
/// bytes are read little-endian as a field element. Padding to 20 (rather than
/// to the field width) is what makes `"CodaSignature"` and
/// `"CodaSignature*******"` hash identically, which Mina's own tests assert.
fn domain_prefix_to_field(prefix: &str) -> BaseField {
    debug_assert!(prefix.len() <= MAX_DOMAIN_STRING_LEN);

    let mut bytes = [0u8; 32];
    let prefix_bytes = prefix.as_bytes();
    for (i, slot) in bytes.iter_mut().take(MAX_DOMAIN_STRING_LEN).enumerate() {
        *slot = if i < prefix_bytes.len() { prefix_bytes[i] } else { b'*' };
    }

    // Bytes 20..32 are zero, so the value is < 2^160 and no reduction occurs.
    BaseField::from_le_bytes_mod_order(&bytes)
}

/// Hash the message and signature context into the challenge scalar `e`.
///
/// Mirrors `mina_hasher`'s `init` + `update` + `digest` sequence exactly:
///
/// 1. absorb the network domain prefix, then squeeze — this salts the sponge
///    and the squeezed value is deliberately discarded;
/// 2. absorb `msg ‖ pk.x ‖ pk.y ‖ rx`;
/// 3. squeeze the digest.
///
/// The digest is a base-field element reinterpreted in the scalar field. That
/// is sound because the two Pasta moduli differ by less than `2^126`, so the
/// probability a squeezed value needs reduction is negligible — the same
/// argument and the same conversion `mina_signer` makes.
fn challenge(
    message: &[BaseField],
    pk_point: &Pallas,
    rx: BaseField,
    network: NetworkId,
) -> ScalarField {
    // The sponge is generic over its full-round count; Mina's kimchi
    // parameters use 55, exposed as `PERM_ROUNDS_FULL` on the constants type.
    const FULL_ROUNDS: usize = PlonkSpongeConstantsKimchi::PERM_ROUNDS_FULL;
    let mut sponge: ArithmeticSponge<BaseField, PlonkSpongeConstantsKimchi, FULL_ROUNDS> =
        ArithmeticSponge::new(fp_kimchi::static_params());

    // Step 1: salt with the network domain.
    sponge.absorb(&[domain_prefix_to_field(network.domain_string())]);
    let _ = sponge.squeeze();

    // Step 2: the signed content.
    let mut input: Vec<BaseField> = Vec::with_capacity(message.len() + 3);
    input.extend_from_slice(message);
    input.push(pk_point.x);
    input.push(pk_point.y);
    input.push(rx);
    sponge.absorb(&input);

    // Step 3: the challenge.
    let digest = sponge.squeeze();
    ScalarField::from_le_bytes_mod_order(&digest.into_bigint().to_bytes_le())
}

/// Verify a Mina Schnorr signature over a message already encoded as field elements.
///
/// `message` must be the caller's canonical field encoding of the payload. This
/// function does not impose one, because the encoding is what binds a signature
/// to a specific MinaPort action.
pub fn verify(
    public_key: &PublicKey,
    signature: &Signature,
    message: &[BaseField],
    network: NetworkId,
) -> Result<(), VerifyError> {
    let pk_point = public_key.decompress()?;

    let e = challenge(message, &pk_point, signature.rx, network);

    // R = s·G − e·pk, computed projectively to avoid per-step inversions.
    let s_g = ProjectivePallas::generator() * signature.s;
    let e_pk = ProjectivePallas::from(pk_point) * e;
    let r = s_g - e_pk;

    if r.is_zero() {
        return Err(VerifyError::ResultAtInfinity);
    }

    let r = r.into_affine();

    if !r.y.into_bigint().is_odd() && r.x == signature.rx {
        Ok(())
    } else {
        Err(VerifyError::SignatureMismatch)
    }
}

/// Convenience wrapper returning a plain boolean.
pub fn is_valid(
    public_key: &PublicKey,
    signature: &Signature,
    message: &[BaseField],
    network: NetworkId,
) -> bool {
    verify(public_key, signature, message, network).is_ok()
}
