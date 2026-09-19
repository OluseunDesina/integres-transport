/**
 * Calendar-date helpers for `YYYY-MM-DD` strings, in the passenger's
 * local time zone. Not `toISOString().slice(0, 10)`: that is UTC, and
 * in Lagos (UTC+1) between 00:00 and 01:00 it names yesterday.
 */
export function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function todayIso(now: Date = new Date()): string {
  return toIsoDate(now);
}

/** Parses as local midnight — `new Date('2026-09-01')` would be UTC. */
export function parseIsoDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function addDays(value: string, days: number): string {
  const date = parseIsoDate(value);
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}
