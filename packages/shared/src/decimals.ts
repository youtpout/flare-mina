/**
 * Bridge decimal policy.
 *
 * The rule, in one sentence: **a bridged token keeps the exact same number of
 * decimals on both chains, and the bridge never converts amounts.**
 *
 * `100000` base units is `0.1 USDT` on Flare and `0.1 USDT` on Mina. Nothing is
 * scaled, so nothing can be scaled wrongly, and a deposit can be checked by
 * comparing two integers.
 *
 * The rule is only achievable for tokens Mina can represent. Its fungible token
 * standard holds balances in `UInt64`, so a supply cannot exceed 2^64 - 1 base
 * units. Tokens above the limit must be wrapped down to 9 decimals first, by
 * `BridgeWrapper` on the Flare side — a deliberate, user-visible step rather
 * than a silent truncation inside a deposit.
 */

/** Mina's fungible token standard stores balances as `UInt64`. */
export const MINA_MAX_BASE_UNITS = (1n << 64n) - 1n;

/**
 * Highest decimals a token may have and still cross unchanged.
 *
 * 9 is not arbitrary: it is MINA's own precision, and it is the largest value
 * that leaves realistic supplies representable. At 12 decimals `UInt64` would
 * cap at ~18 million whole tokens — below the circulating supply of ETH.
 */
export const MAX_BRIDGEABLE_DECIMALS = 9;

/** Decimals every wrapped (previously too-precise) asset ends up with. */
export const WRAPPER_DECIMALS = 9;

export type BridgePlan =
  | { kind: 'direct'; decimals: number }
  | { kind: 'wrap'; fromDecimals: number; toDecimals: number; scale: bigint };

/**
 * How a token with `decimals` reaches Mina.
 *
 * `direct` means it crosses untouched, keeping its own decimals. `wrap` means it
 * must go through `BridgeWrapper` first, losing everything below `scale`.
 */
export function bridgePlanFor(decimals: number): BridgePlan {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`implausible token decimals: ${decimals}`);
  }

  if (decimals <= MAX_BRIDGEABLE_DECIMALS) {
    return { kind: 'direct', decimals };
  }

  return {
    kind: 'wrap',
    fromDecimals: decimals,
    toDecimals: WRAPPER_DECIMALS,
    scale: 10n ** BigInt(decimals - WRAPPER_DECIMALS),
  };
}

/** Largest whole-token supply Mina can represent at `decimals`. */
export function maxRepresentableSupply(decimals: number): bigint {
  return MINA_MAX_BASE_UNITS / 10n ** BigInt(decimals);
}

/**
 * Largest amount at or below `amount` that survives wrapping intact.
 *
 * Frontends must show this — and the difference — before asking a user to wrap,
 * so the precision they give up is a choice rather than a surprise.
 */
export function roundDownToWrappable(amount: bigint, decimals: number): bigint {
  const plan = bridgePlanFor(decimals);
  if (plan.kind === 'direct') return amount;
  return amount - (amount % plan.scale);
}

/** Amount that would be left behind by wrapping `amount`. */
export function wrappingDust(amount: bigint, decimals: number): bigint {
  const plan = bridgePlanFor(decimals);
  if (plan.kind === 'direct') return 0n;
  return amount % plan.scale;
}
