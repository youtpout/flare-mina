import { Field } from 'o1js';

/**
 * Mina-side protocol constants.
 *
 * Mirror of `@minaport/shared/constants`, expressed as field elements because
 * Poseidon operates on the Pallas base field rather than on bytes.
 */

/** Poseidon domain tag for deposit leaves: ASCII "MINAPORT" as a field element. */
export const DEPOSIT_DOMAIN = Field(0x4d494e41504f5254n);

/** Poseidon domain tag for withdrawal records: ASCII "MINAPOWD". */
export const WITHDRAWAL_DOMAIN = Field(0x4d494e41504f5744n);

/** An EVM address is 160 bits; every recipient field is range-checked to this. */
export const EVM_ADDRESS_BITS = 160;

/** 1 MINA = 1e9 nanomina. FMINA uses the same base unit (see shared/constants). */
export const NANOMINA_PER_MINA = 1_000_000_000n;
