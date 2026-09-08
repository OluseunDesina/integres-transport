import { computed, signal } from '@angular/core';
import type { ParamMap } from '@angular/router';
import type { FilterChip, SelectOption } from '@shared-ui';

export type Granularity = 'day' | 'week' | 'month';

export const GRANULARITY_OPTIONS: SelectOption[] = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
];

const GRANULARITIES: readonly Granularity[] = ['day', 'week', 'month'];

/** The keys this owns in the URL. `business` is deliberately absent — it
 * is `SelectedBusinessStore`'s, app-wide, and giving one fact two homes
 * is how they come to disagree. */
export const PERIOD_URL_KEYS = ['date_from', 'date_to', 'granularity'] as const;

export function isGranularity(value: string | null): value is Granularity {
  return value !== null && (GRANULARITIES as readonly string[]).includes(value);
}

/** `YYYY-MM-DD` or nothing. Anything else is a hand-edited URL and must
 * not reach the endpoint as a 400 the operator did not ask for. */
export function asIsoDate(value: string | null): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

export interface PeriodQuery {
  date_from?: string;
  date_to?: string;
  granularity?: Granularity;
}

/**
 * The period every analytics screen filters by, and its URL round-trip.
 *
 * A plain class instantiated per screen, the shape `ListFilters` already
 * established — not a service, because two screens open at once in
 * different tabs must not share a period.
 *
 * Extracted on the third copy. The dashboard hand-rolled this in slice
 * 3; the revenue and transactions screens needed exactly the same
 * signals, the same validators, the same chips and the same
 * `replaceUrl` merge, and three hand-written copies of a filter that
 * drives what numbers appear on screen is how two of them come to
 * disagree about what "this week" means.
 *
 * The period is the one thing on these screens worth sending someone,
 * which is why it round-trips through the URL at all.
 */
export class PeriodFilters {
  readonly dateFrom = signal('');
  readonly dateTo = signal('');
  readonly granularity = signal<Granularity>('day');

  readonly chips = computed<FilterChip[]>(() => {
    const chips: FilterChip[] = [];
    if (this.dateFrom()) {
      chips.push({ id: 'date_from', label: 'From', value: this.dateFrom() });
    }
    if (this.dateTo()) {
      chips.push({ id: 'date_to', label: 'To', value: this.dateTo() });
    }
    if (this.granularity() !== 'day') {
      chips.push({
        id: 'granularity',
        label: 'Grouped',
        value:
          GRANULARITY_OPTIONS.find((option) => option.value === this.granularity())?.label ??
          this.granularity(),
      });
    }
    return chips;
  });

  /** Seed from a route's query params, ignoring anything malformed. */
  seed(params: ParamMap): void {
    this.dateFrom.set(asIsoDate(params.get('date_from')) ?? '');
    this.dateTo.set(asIsoDate(params.get('date_to')) ?? '');
    const granularity = params.get('granularity');
    this.granularity.set(isGranularity(granularity) ? granularity : 'day');
  }

  /** For a screen that buckets a trend. */
  query(): PeriodQuery {
    return { ...this.dateQuery(), granularity: this.granularity() };
  }

  /** For a screen that does not.
   *
   * `GET /payments/` is a record list, so a bucket size means nothing to
   * it — sending one anyway would put a parameter in the query that
   * changes no rows, which is exactly the sort of thing a later reader
   * has to disprove. The `granularity` control is not rendered on that
   * screen either, so nothing could set it. */
  dateQuery(): Omit<PeriodQuery, 'granularity'> {
    return {
      date_from: this.dateFrom() || undefined,
      date_to: this.dateTo() || undefined,
    };
  }

  /** What to merge into the URL. The default granularity is written as
   * `null` so it drops out — a shared link should carry only what the
   * operator actually changed. */
  urlParams(): Record<string, string | null> {
    return {
      date_from: this.dateFrom() || null,
      date_to: this.dateTo() || null,
      granularity: this.granularity() === 'day' ? null : this.granularity(),
    };
  }

  setGranularity(value: string): void {
    if (isGranularity(value)) {
      this.granularity.set(value);
    }
  }

  remove(chipId: string): void {
    if (chipId === 'date_from') {
      this.dateFrom.set('');
    } else if (chipId === 'date_to') {
      this.dateTo.set('');
    } else {
      this.granularity.set('day');
    }
  }

  clear(): void {
    this.dateFrom.set('');
    this.dateTo.set('');
    this.granularity.set('day');
  }
}
