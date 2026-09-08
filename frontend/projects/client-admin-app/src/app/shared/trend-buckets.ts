import type { ChartPoint } from '@shared-ui';

export type Granularity = 'day' | 'week' | 'month';

/** A hard safety cap on axis length, not an expected ceiling — the
 * backend's own per-granularity range caps (92 days / 366 / 1827) keep
 * a real request well under this. */
const MAX_BUCKETS = 2000;

function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Every bucket the selected period covers, as `YYYY-MM-DD` labels.
 *
 * **All arithmetic is in UTC**, deliberately. A plain
 * `new Date('2026-08-01')` is UTC midnight, so reading `getDate()` off
 * it in any negative-offset timezone yields July 31 — an off-by-one
 * that would shift the entire axis for half the world's operators. The
 * `period` these dates come from is already resolved in the Business's
 * timezone by the backend; re-interpreting it in the browser's would
 * undo that work.
 *
 * Week buckets start on **Monday**, matching Postgres `date_trunc` and
 * therefore Django's `TruncWeek`, which is what produced the dates on
 * the other side.
 */
export function expandBuckets(from: string, to: string, granularity: Granularity): string[] {
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  if (!start || !end || start > end) {
    return [];
  }

  const cursor = new Date(start.getTime());
  if (granularity === 'week') {
    // getUTCDay(): 0 = Sunday. Walk back to the Monday on or before.
    const offset = (cursor.getUTCDay() + 6) % 7;
    cursor.setUTCDate(cursor.getUTCDate() - offset);
  } else if (granularity === 'month') {
    cursor.setUTCDate(1);
  }

  const out: string[] = [];
  while (cursor <= end && out.length < MAX_BUCKETS) {
    out.push(toIsoDate(cursor));
    if (granularity === 'day') {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } else if (granularity === 'week') {
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    } else {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  return out;
}

/**
 * The trend series a chart should draw, with **missing buckets marked as
 * gaps rather than zeros**.
 *
 * The endpoints emit only buckets that have data — a deliberate shape
 * choice recorded in `apps/analytics/serializers.py`, so that "no
 * revenue on Tuesday" and "this Business did not exist on Tuesday"
 * cannot arrive identically. That distinction only survives to the
 * screen if the client puts the empty buckets back as `null`, which is
 * what this does. Plotting the returned points alone would draw a
 * straight line across a week of silence.
 *
 * **If the expansion and the server disagree, the server wins.** Should
 * any returned date fall outside the axis this derives, the raw points
 * are returned untouched — an axis this function got wrong would
 * silently *drop* real data, which is far worse than a chart that
 * merely fails to show gaps.
 */
export function toTrendPoints(
  from: string,
  to: string,
  granularity: Granularity,
  points: readonly { date: string; value: number }[]
): ChartPoint[] {
  const axis = expandBuckets(from, to, granularity);
  const byDate = new Map(points.map((point) => [point.date, point.value]));

  if (axis.length === 0 || points.some((point) => !axis.includes(point.date))) {
    return points.map((point) => ({ label: point.date, value: point.value }));
  }

  return axis.map((date) => ({ label: date, value: byDate.get(date) ?? null }));
}
