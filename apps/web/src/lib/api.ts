/**
 * Read a JSON body, or fail with something a person can act on.
 *
 * `res.json()` on a non-JSON body throws "Unexpected end of JSON input", which
 * names the parser rather than the problem. It is what the user sees when the
 * relayer restarts mid-request and the proxy answers 502 with an empty body —
 * a message that sends you looking for a bug in the frontend.
 */
export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();

  try {
    return JSON.parse(text) as T;
  } catch {
    // Proxies answer with HTML or nothing at all; neither belongs on screen.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error(
        `The relayer is not answering (${res.status}). It may be restarting or busy proving — ` +
          'wait a moment and try again.',
      );
    }
    const detail = text.trim().slice(0, 200);
    throw new Error(
      detail.length > 0
        ? `The relayer answered ${res.status} with an unexpected body: ${detail}`
        : `The relayer answered ${res.status} with an empty body.`,
    );
  }
}
