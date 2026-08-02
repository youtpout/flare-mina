//! Canonical MinaPort authorization: the structure a Mina key signs, and the
//! ABI the Flare contracts consume.
//!
//! One authorization says: *"the Mina account `minaPublicKey` authorises
//! `actionHash` on contract `target`, on chain `chainId`, valid until `expiry`,
//! with anti-replay nonce `nonce`."*
//!
//! The `actionHash` is opaque here on purpose. That is what lets one verifier
//! serve every use case: binding an EVM controller, authorising a swap, or
//! anything added later. The consuming contract decides what the hash means.
//!
//! # Two encodings, one meaning
//!
//! - **Field encoding** ([`Authorization::to_fields`]) — what the Mina key
//!   actually signs, because Mina's sponge absorbs field elements.
//! - **ABI encoding** ([`SolAuthorization`]) — what the guest commits, because
//!   Solidity has to `abi.decode` it.
//!
//! Both are derived from the same struct, and the cross-language fixture tests
//! pin them against the TypeScript mirror in `@minaport/shared`.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::vec::Vec;

use alloy_sol_types::sol;
use ark_ff::PrimeField;
use minaport_schnorr::{BaseField, NetworkId, PublicKey, Signature, VerifyError};

sol! {
    /// Solidity mirror. `abi.encode(MinaAuthorization[])` is what the guest
    /// commits as SP1 public values.
    #[derive(Debug, PartialEq, Eq)]
    struct MinaAuthorization {
        /// Mina public key packed as `x | isOdd << 255`.
        bytes32 minaPublicKey;
        /// EVM chain the authorization is valid on.
        uint256 chainId;
        /// Contract the authorization is addressed to.
        address target;
        /// Opaque commitment to the authorised action.
        bytes32 actionHash;
        /// Per-key anti-replay nonce.
        uint64 nonce;
        /// Unix seconds after which the authorization is void.
        uint64 expiry;
    }
}

/// Native form of an authorization.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Authorization {
    pub mina_public_key: PublicKey,
    pub chain_id: u64,
    /// EVM address, big-endian.
    pub target: [u8; 20],
    pub action_hash: [u8; 32],
    pub nonce: u64,
    pub expiry: u64,
}

/// Number of field elements [`Authorization::to_fields`] produces.
pub const AUTHORIZATION_FIELDS: usize = 6;

impl Authorization {
    /// Canonical field encoding — exactly what the Mina key signs.
    ///
    /// Layout (6 field elements):
    ///
    /// | index | content                        | width   |
    /// |-------|--------------------------------|---------|
    /// | 0     | `chainId`                      | 64 bits |
    /// | 1     | `target`, big-endian            | 160 bits|
    /// | 2     | `actionHash[0..16]`, big-endian | 128 bits|
    /// | 3     | `actionHash[16..32]`, big-endian| 128 bits|
    /// | 4     | `nonce`                        | 64 bits |
    /// | 5     | `expiry`                       | 64 bits |
    ///
    /// `actionHash` is split across two field elements because a Pallas field
    /// element holds ~254 bits and a keccak digest is 256 — packing it whole
    /// would silently reduce modulo the field order, letting two distinct
    /// actions share an encoding. The 128/128 split is lossless.
    ///
    /// The signer's own public key is NOT included: it is already absorbed by
    /// Mina's signing scheme (`pk.x`, `pk.y` enter the challenge), so adding it
    /// here would be redundant, not safer.
    pub fn to_fields(&self) -> Vec<BaseField> {
        let mut fields = Vec::with_capacity(AUTHORIZATION_FIELDS);

        fields.push(BaseField::from(self.chain_id));

        let mut target = [0u8; 32];
        target[12..32].copy_from_slice(&self.target);
        fields.push(BaseField::from_be_bytes_mod_order(&target));

        fields.push(BaseField::from_be_bytes_mod_order(&self.action_hash[0..16]));
        fields.push(BaseField::from_be_bytes_mod_order(&self.action_hash[16..32]));

        fields.push(BaseField::from(self.nonce));
        fields.push(BaseField::from(self.expiry));

        fields
    }

    /// Pack the signer's Mina key into the `bytes32` form the EVM uses.
    ///
    /// `x | isOdd << 255`. Mirrors `MinaAddressLib.pack` (Solidity) and
    /// `encodeMinaRecipient` (TypeScript).
    pub fn packed_public_key(&self) -> [u8; 32] {
        let mut packed = [0u8; 32];
        let x = self.mina_public_key.x.into_bigint().to_bytes_be();
        // `to_bytes_be` is already 32 bytes for a 255-bit field.
        packed.copy_from_slice(&x);
        if self.mina_public_key.is_odd {
            packed[0] |= 0x80;
        }
        packed
    }

    /// Verify the Mina signature over this authorization.
    pub fn verify(&self, signature: &Signature, network: NetworkId) -> Result<(), VerifyError> {
        minaport_schnorr::verify(
            &self.mina_public_key,
            signature,
            &self.to_fields(),
            network,
        )
    }

    /// Convert to the Solidity struct committed as public values.
    pub fn to_sol(&self) -> MinaAuthorization {
        MinaAuthorization {
            minaPublicKey: self.packed_public_key().into(),
            chainId: alloy_sol_types::private::U256::from(self.chain_id),
            target: alloy_sol_types::private::Address::from(self.target),
            actionHash: self.action_hash.into(),
            nonce: self.nonce,
            expiry: self.expiry,
        }
    }
}

/// A signed authorization, as handed to the guest.
#[derive(Clone, Copy, Debug)]
pub struct SignedAuthorization {
    pub authorization: Authorization,
    pub signature: Signature,
}

/// Verify a whole batch, returning the Solidity structs to commit.
///
/// Returns `Err` on the FIRST invalid signature. The guest turns that into a
/// panic, so an SP1 proof exists only when every authorization in the batch
/// verified — there is deliberately no per-item validity flag a consumer could
/// forget to check.
pub fn verify_batch(
    batch: &[SignedAuthorization],
    network: NetworkId,
) -> Result<Vec<MinaAuthorization>, (usize, VerifyError)> {
    let mut out = Vec::with_capacity(batch.len());
    for (index, signed) in batch.iter().enumerate() {
        signed
            .authorization
            .verify(&signed.signature, network)
            .map_err(|e| (index, e))?;
        out.push(signed.authorization.to_sol());
    }
    Ok(out)
}
