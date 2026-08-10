/**
 * Turn whatever a wallet or an RPC threw into something worth showing.
 *
 * `String(e)` was the old answer and it prints `[object Object]`: wallets reject
 * with a plain `{code, message}`, not an `Error`, so neither branch of
 * `e instanceof Error ? e.message : String(e)` produces anything readable.
 *
 * A cancellation is reported as such rather than as a failure: the user knows
 * they declined, and the screen should say so instead of going quiet or blaming
 * them for an error.
 */

/** What a declined signature or connection reads as. */
export const CANCELLED_BY_USER = 'Cancelled by user.';

/** EIP-1193 user rejection, and Auro's own code for the same thing. */
const REJECTED = new Set([4001, 1002]);

const CANCELLED = /\b(user (rejected|denied|declined|cancell?ed)|request rejected|cancell?ed)\b/i;

export function errorMessage(e: unknown): string {
  const record = typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : undefined;

  const code = record?.code;
  if (typeof code === 'number' && REJECTED.has(code)) return CANCELLED_BY_USER;

  // Wallets nest the real reason one level down as often as not.
  const nested = record?.error;
  if (typeof nested === 'object' && nested !== null) {
    const inner = (nested as Record<string, unknown>).code;
    if (typeof inner === 'number' && REJECTED.has(inner)) return CANCELLED_BY_USER;
  }

  const text =
    e instanceof Error
      ? e.message
      : typeof record?.message === 'string'
        ? record.message
        : typeof e === 'string'
          ? e
          : JSON.stringify(e);

  if (typeof text === 'string' && CANCELLED.test(text)) return CANCELLED_BY_USER;

  // JSON.stringify returns undefined for a symbol or a function; never show that.
  return typeof text === 'string' && text.length > 0 ? text : 'Something went wrong.';
}
