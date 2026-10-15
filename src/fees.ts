/** Money helpers. All amounts are integer cents. */
export const FEE_RATE = 0.10;
export const FEE_CAP_RATE = 0.15;
export const FEE_MIN_CENTS = 50;

/**
 * Fairplug fee on a VALIDATED commission: 10%, floored at US$0.50, but never above 15% of the
 * commission (cap wins over the minimum on tiny commissions, so the fee can't exceed 15%).
 * Network fees are passed through at cost separately.
 *
 * SMALL-COMMISSION EDGE CASE: the US$0.50 minimum would exceed the 15% cap whenever commission < ~US$3.33
 * (0.50 / 0.15). In that range the 15% cap OVERRIDES the minimum: fee = floor(15% x commission).
 * Example: a $2.00 commission pays $0.30 (not $0.50); a $3.00 commission pays $0.45; $4.00 pays $0.50 (min applies).
 * Cap is floored to a whole cent so the fee never exceeds 15%. Assumed interpretation; confirm with the spec owner.
 */
export function fairplugFeeCents(commissionCents: number): number {
  if (commissionCents <= 0) return 0;
  const base = Math.round(commissionCents * FEE_RATE);
  const cap = Math.floor(commissionCents * FEE_CAP_RATE);
  return Math.min(Math.max(base, FEE_MIN_CENTS), cap);
}

export const usd = (c: number) => (c < 0 ? "-" : "") + "$" + (Math.abs(c) / 100).toFixed(2);
