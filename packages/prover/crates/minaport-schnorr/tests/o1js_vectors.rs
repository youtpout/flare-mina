//! Conformance tests against signatures produced by o1js.
//!
//! Vectors were generated with:
//!
//! ```js
//! const sk  = PrivateKey.fromBigInt(n);
//! const sig = Signature.create(sk, msgFields);   // o1js default network
//! ```
//!
//! o1js's `Signature.create` targets the testnet/devnet domain
//! (`"CodaSignature"`), so these exercise [`NetworkId::Testnet`]. The mainnet
//! path differs only by the domain prefix, and `rejects_wrong_network` pins that
//! the two are not interchangeable.

use minaport_schnorr::{is_valid, verify, BaseField, NetworkId, PublicKey, ScalarField, Signature, VerifyError};
use std::str::FromStr;

struct Vector {
    pk_x: &'static str,
    pk_is_odd: bool,
    msg: &'static [&'static str],
    rx: &'static str,
    s: &'static str,
}

const VECTORS: &[Vector] = &[
    Vector {
        pk_x: "28458361157200061646275075754670616707828565372579655071645359937703726536371",
        pk_is_odd: true,
        msg: &["11", "22"],
        rx: "17886411415089962440654512926903791657347673995368507775091595326741003920384",
        s: "23526475448460078932579517507487500402302677187905851962120003756237115094819",
    },
    Vector {
        pk_x: "13386019024431262222823433559007653063384989782877316892062967640001759191355",
        pk_is_odd: true,
        msg: &["22", "44"],
        rx: "17075101623349901098156794354551043302348373490128886255351679684496420248923",
        s: "2728729124507309808736641100963180990592035922959104853274880777693849842076",
    },
    Vector {
        pk_x: "8802991696068510855712751822202156344780430110168476152437677908131014442562",
        pk_is_odd: true,
        msg: &["33", "66"],
        rx: "9869548486958001433867753221972782422059932325027208627300395971357104466532",
        s: "22563578004169192810093956982665144095732964799177130644502509147766056412320",
    },
];

fn parts(v: &Vector) -> (PublicKey, Signature, Vec<BaseField>) {
    let public_key = PublicKey {
        x: BaseField::from_str(v.pk_x).unwrap(),
        is_odd: v.pk_is_odd,
    };
    let signature = Signature {
        rx: BaseField::from_str(v.rx).unwrap(),
        s: ScalarField::from_str(v.s).unwrap(),
    };
    let message = v.msg.iter().map(|m| BaseField::from_str(m).unwrap()).collect();
    (public_key, signature, message)
}

#[test]
fn accepts_o1js_signatures() {
    for (i, v) in VECTORS.iter().enumerate() {
        let (pk, sig, msg) = parts(v);
        assert!(
            is_valid(&pk, &sig, &msg, NetworkId::Testnet),
            "vector {i} should verify",
        );
    }
}

#[test]
fn rejects_tampered_message() {
    let (pk, sig, mut msg) = parts(&VECTORS[0]);
    msg[0] += BaseField::from(1u64);
    assert_eq!(
        verify(&pk, &sig, &msg, NetworkId::Testnet),
        Err(VerifyError::SignatureMismatch),
    );
}

#[test]
fn rejects_tampered_scalar() {
    let (pk, mut sig, msg) = parts(&VECTORS[0]);
    sig.s += ScalarField::from(1u64);
    assert_eq!(
        verify(&pk, &sig, &msg, NetworkId::Testnet),
        Err(VerifyError::SignatureMismatch),
    );
}

#[test]
fn rejects_tampered_rx() {
    let (pk, mut sig, msg) = parts(&VECTORS[0]);
    sig.rx += BaseField::from(1u64);
    assert_eq!(
        verify(&pk, &sig, &msg, NetworkId::Testnet),
        Err(VerifyError::SignatureMismatch),
    );
}

#[test]
fn rejects_signature_from_another_key() {
    let (_, sig, msg) = parts(&VECTORS[0]);
    let (other_pk, _, _) = parts(&VECTORS[1]);
    assert!(!is_valid(&other_pk, &sig, &msg, NetworkId::Testnet));
}

#[test]
fn rejects_message_from_another_vector() {
    let (pk, sig, _) = parts(&VECTORS[0]);
    let (_, _, other_msg) = parts(&VECTORS[1]);
    assert!(!is_valid(&pk, &sig, &other_msg, NetworkId::Testnet));
}

/// A devnet signature must not verify against the mainnet domain. This is the
/// property MinaPort relies on to keep testnet authorisations off mainnet.
#[test]
fn rejects_wrong_network() {
    for v in VECTORS {
        let (pk, sig, msg) = parts(v);
        assert!(is_valid(&pk, &sig, &msg, NetworkId::Testnet));
        assert!(
            !is_valid(&pk, &sig, &msg, NetworkId::Mainnet),
            "a testnet signature must not verify as mainnet",
        );
    }
}

/// An `x` with no corresponding curve point must be rejected outright rather
/// than silently treated as a valid group element.
#[test]
fn rejects_off_curve_public_key() {
    // x = 0 -> y² = 5, and 5 is a non-residue in the Pallas base field.
    let pk = PublicKey { x: BaseField::from(0u64), is_odd: false };
    let (_, sig, msg) = parts(&VECTORS[0]);
    assert_eq!(
        verify(&pk, &sig, &msg, NetworkId::Testnet),
        Err(VerifyError::PublicKeyNotOnCurve),
    );
}

/// Parity matters: the same `x` with the wrong `is_odd` is a different point.
#[test]
fn rejects_wrong_parity() {
    let (mut pk, sig, msg) = parts(&VECTORS[0]);
    pk.is_odd = !pk.is_odd;
    assert!(!is_valid(&pk, &sig, &msg, NetworkId::Testnet));
}
