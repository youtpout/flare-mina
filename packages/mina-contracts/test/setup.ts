import { initializeBindings, setBackend } from 'o1js';

/**
 * Run every suite on the native backend, as the relayer does.
 *
 * Two reasons, and the second is not a preference.
 *
 * Timings measured under wasm are not the timings production sees — the native
 * addon is roughly 1.8x faster on these circuits, so a suite that reports the
 * wasm number is quietly misleading about what a publication costs.
 *
 * And `FdcLeaf` does not compile under wasm at all once its prover key is
 * serialised: at four chunks the key overflows the wasm heap inside
 * `encodeProverKey`, which surfaces as an allocation failure deep in kimchi
 * rather than as anything resembling a circuit error.
 */
setBackend('native');
await initializeBindings();
