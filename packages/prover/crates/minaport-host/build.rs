fn main() {
    // Build the guest with the `sp1` feature so Pasta Fp/Fq Montgomery
    // multiplication routes through the zkVM's `sys_bigint` precompile. The
    // host's own mina-curves is unaffected.
    let args = sp1_build::BuildArgs {
        features: vec!["sp1".to_string()],
        ..Default::default()
    };
    sp1_build::build_program_with_args("../minaport-guest", args);
}
