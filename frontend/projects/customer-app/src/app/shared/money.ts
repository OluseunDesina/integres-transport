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

/* `formatMoney` moved to `@shared-ui` in spec 14 slice 6b, when
 * `validator-app` turned out to be rendering the same amounts in the
 * opposite order. Re-exported here so this app's twelve call sites keep
 * importing money helpers from one place. */
export { formatMoney } from '@shared-ui';
