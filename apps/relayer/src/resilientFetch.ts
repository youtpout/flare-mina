/**
 * Bounds how long one HTTP request may stall, and retries when it does.
 *
 * # Why this exists
 *
 * The public Mina endpoints stall. Not fail — stall, then answer 200 about
 * sixty seconds later. Measured with plain `fetch` and no o1js in the picture:
 *
 *   request 0: 115ms    request 1: 60204ms    request 2: 107ms
 *
 * It is intermittent and lands on roughly one request in three, whichever that
 * happens to be. The first time it surfaced it looked like a two-minute prover;
 * the proof was 2.7s and the rest was one stalled GraphQL call.
 *
 * None of the usual suspects explained it. `--dns-result-order=ipv4first` did
 * not help, so it is not the AAAA records these hosts publish. A short
 * keep-alive did not help, so it is not a socket the far end had already
 * closed. A connect timeout did not fire, so the TCP handshake completes. The
 * endpoint simply goes quiet mid-request and comes back.
 *
 * So rather than diagnose someone else's infrastructure, this bounds it: give
 * up after `TIMEOUT_MS` and try again. The worst case becomes one timeout plus
 * a fast retry instead of a minute of silence.
 *
 * The timeout is 2.5s because healthy responses measure 60-200ms. The first
 * real deposit spent 24.6s of its 27s in three separate stalls, each burning
 * an 8s timeout before retrying; at 2.5s the same deposit would have waited a
 * third as long. Set it lower and a merely slow response gets abandoned; the
 * retry count absorbs the difference.
 *
 * # Why it patches the global
 *
 * o1js does its own fetching — `fetchAccount`, and whatever transaction
 * building reaches for — and none of it takes an injected client. Patching
 * `globalThis.fetch` is the only way to cover those calls, and they are exactly
 * the ones that were stalling.
 */

const TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS ?? 2_500);
const ATTEMPTS = Number(process.env.HTTP_ATTEMPTS ?? 5);

export function installResilientFetch(): void {
  const original = globalThis.fetch;
  // Idempotent: a second call would wrap the wrapper and multiply the timeouts.
  if ((globalThis as { __resilientFetch?: boolean }).__resilientFetch) return;
  (globalThis as { __resilientFetch?: boolean }).__resilientFetch = true;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let last: unknown;

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        // A caller's own signal still wins: `AbortSignal.any` aborts on
        // whichever fires first, so a cancelled request stays cancelled
        // instead of being retried behind the caller's back.
        const timeout = AbortSignal.timeout(TIMEOUT_MS);
        const signal =
          init?.signal != null ? AbortSignal.any([init.signal, timeout]) : timeout;

        return await original(input, { ...init, signal });
      } catch (error) {
        last = error;
        if (init?.signal?.aborted) throw error;
      }
    }

    throw last;
  };
}
