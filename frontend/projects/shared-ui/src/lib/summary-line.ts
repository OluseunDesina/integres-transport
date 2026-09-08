/**
 * Builds the sub-line `ui-table`'s responsive-column convention puts
 * under a row's primary cell — the compressed form of the columns
 * hidden below `md`.
 *
 * Here rather than in one app because all three apps' lists need the
 * identical shape, and because the two things that make these lines
 * read badly are exactly the two things a per-screen template inlines
 * wrongly: a stray separator around a value that turned out to be
 * empty, and "1 stops".
 *
 * @example
 * summaryLine([route.code, plural(route.stops.length, 'stop')])
 * // "LAG-IBD · 6 stops", or "6 stops" when the route has no code
 */
export function summaryLine(parts: readonly (string | number | null | undefined)[]): string {
  return parts
    .map((part) => (typeof part === 'number' ? String(part) : (part ?? '').trim()))
    .filter((part) => part.length > 0)
    .join(' · ');
}

/**
 * `plural(1, 'stop')` → `"1 stop"`; `plural(6, 'stop')` → `"6 stops"`.
 *
 * Pass `pluralForm` for anything the trailing "s" gets wrong.
 */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}
