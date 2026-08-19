/**
 * The seat picker multiplies a per-seat fare by a seat count to show a
 * running total. `CLAUDE.md`'s "money is Decimal, never float" rule is a
 * backend convention, but the same hazard exists here: the API returns
 * amounts as decimal *strings* precisely so they survive the wire
 * intact, and `Number('0.10') * 3` would reintroduce binary-float error
 * at the last place on the very first multiplication.
 *
 * These work on the digit string via BigInt, so the result is exact and
 * keeps the server's own scale (`"750.00"` × 2 → `"1500.00"`, not
 * `"1500"`).
 */

/** Multiplies a decimal string by a non-negative integer, exactly. */
export function multiplyDecimal(amount: string, count: number): string {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Seat count must be a non-negative integer, got ${count}.`);
  }
  const [whole, fraction = ''] = amount.split('.');
  const scaled = BigInt(`${whole}${fraction}`) * BigInt(count);
  if (fraction.length === 0) {
    return scaled.toString();
  }
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(fraction.length + 1, '0');
  const splitAt = digits.length - fraction.length;
  return `${negative ? '-' : ''}${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;
}

/** `"1500.00"` + `"NGN"` → `"NGN 1500.00"`. Currency comes from the
 * Business (`GET /trips/{id}/fare/`), never a platform-wide constant —
 * Lagos and Gaborone coexist in one install. */
export function formatMoney(amount: string, currency: string): string {
  return `${currency} ${amount}`;
}
