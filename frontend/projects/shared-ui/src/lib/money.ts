/**
 * `"1500.00"` + `"NGN"` → `"NGN 1500.00"`.
 *
 * Currency comes from the Business, never a platform-wide constant —
 * Lagos and Gaborone coexist in one install, and `docs/adr/0007` names
 * Botswana as a tracked gap rather than an impossibility.
 *
 * Trivial, and here anyway, because the alternative is what the
 * workspace actually had: `customer-app` held the original,
 * `client-admin-app`'s `booking-list` kept a private copy whose comment
 * said it was local *because* the helper was not in a shared library,
 * and `validator-app` interpolated the two values by hand in the
 * opposite order — so the same money read "NGN 300.00" on three screens
 * and "300.00 NGN" on a fourth.
 *
 * Amounts stay decimal **strings** end to end: the API returns them that
 * way precisely so they survive the wire intact, and this must never
 * take a `number`. Arithmetic on them belongs in
 * `customer-app/src/app/shared/money.ts`'s `multiplyDecimal`, which is
 * seat-fare maths rather than formatting and stays where its one caller
 * is.
 */
export function formatMoney(amount: string, currency: string): string {
  return `${currency} ${amount}`;
}
