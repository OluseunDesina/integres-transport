import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { Alert, Button, EmptyState, Icon, Skeleton, StatusPill, plural } from '@shared-ui';

import { BookingSteps } from '../shared/booking-steps';
import type { SeatPickerRequest } from '../shared/booking-draft';
import { addDays, parseIsoDate, todayIso } from '../shared/dates';
import { formatMoney } from '../shared/money';
import { tripClassLabel } from '../shared/trip-class';

type TripSearchResultRow = components['schemas']['TripSearchResult'];
type Trip = components['schemas']['Trip'];

type SortKey = 'departure' | 'price' | 'duration';

/** Departure time of day, by the passenger's local clock — the same
 * clock every time on the card is rendered in. */
export type TimeBucket = 'morning' | 'afternoon' | 'evening';

const TIME_BUCKETS: { id: TimeBucket; label: string; hint: string }[] = [
  { id: 'morning', label: 'Morning', hint: 'Before 12:00' },
  { id: 'afternoon', label: 'Afternoon', hint: '12:00 – 17:00' },
  { id: 'evening', label: 'Evening', hint: 'After 17:00' },
];

/** How many days either side of the searched one the date strip offers. */
const DATE_STRIP_RADIUS = 3;

/** White text on each measures ≥ 4.5:1 (Tailwind's 700 steps). */
const AVATAR_COLOURS = [
  'bg-blue-700',
  'bg-emerald-700',
  'bg-violet-700',
  'bg-rose-700',
  'bg-teal-700',
  'bg-amber-700',
];

export function timeBucket(isoDateTime: string): TimeBucket {
  const hour = new Date(isoDateTime).getHours();
  if (hour < 12) {
    return 'morning';
  }
  return hour < 17 ? 'afternoon' : 'evening';
}

/** "GUO Transport" → "GT", "ABC" → "AB". */
export function operatorInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return '?';
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Deterministic, so one operator keeps one colour across renders and
 * searches — docs/specs/24-marketplace-redesign.md. */
export function operatorColour(name: string): string {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return AVATAR_COLOURS[hash % AVATAR_COLOURS.length];
}

export function resultKey(row: TripSearchResultRow): string {
  return `${row.trip.id}:${row.from_stop.id}:${row.to_stop.id}`;
}

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return fallback;
}

/** "3h 30m" / "45m" — never "3h 0m", and never rendered at all when the
 * operator hasn't set a route duration (this function is only called
 * once a result's `duration_minutes` is known non-null). */
function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) {
    return `${remainder}m`;
  }
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

/**
 * Search results — docs/specs/22-marketplace.md slice 2, redesigned by
 * docs/specs/24-marketplace-redesign.md after wakanow.com: a summary bar
 * with "Modify search", a date strip, a filter sidebar (operator, class,
 * time of day, direct-only — all client-side over the rows already
 * fetched), sort tabs showing each sort's best value, and boarding-pass
 * style cards. Its own route
 * (`/search/results`), not a block on `trip-search.ts`'s own state: a
 * passenger filtering/sorting a real result set, bookmarking a search,
 * or refreshing mid-browse all need the search itself to be
 * re-runnable from the URL alone, which router state cannot do. Public
 * — a guest can reach this with no session (`app.routes.ts`).
 *
 * Reads its query from `origin`/`destination`/`service_date`/
 * `trip_class` query params (written by `trip-search.ts`'s `search()`)
 * and re-fetches whenever they change, rather than trusting anything
 * carried in as router state — the same "nothing here is trusted for
 * correctness, always refetch" discipline `booking-draft.ts` documents
 * for the seat-picker step.
 */
@Component({
  selector: 'app-search-results',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    BookingSteps,
    Alert,
    Button,
    EmptyState,
    Icon,
    Skeleton,
    StatusPill,
  ],
  templateUrl: './search-results.html',
})
export class SearchResults implements OnInit {
  private readonly api = inject(API_CLIENT);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly sortKey = signal<SortKey>('departure');
  protected readonly timeBuckets = TIME_BUCKETS;
  protected readonly sortTabs: { key: SortKey; label: string }[] = [
    { key: 'departure', label: 'Earliest' },
    { key: 'price', label: 'Cheapest' },
    { key: 'duration', label: 'Fastest' },
  ];
  protected readonly filterRowClass =
    'flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm text-default hover:bg-surface-muted';
  protected readonly checkboxClass = 'h-4 w-4 shrink-0 rounded border-control accent-primary';

  // Filters. Reset on every new search: a different day may not run the
  // operator that was ticked, and a filter the passenger can't see
  // silently emptying the list is worse than starting clean.
  protected readonly selectedOperators = signal<ReadonlySet<string>>(new Set());
  protected readonly selectedClasses = signal<ReadonlySet<string>>(new Set());
  protected readonly selectedTimes = signal<ReadonlySet<TimeBucket>>(new Set());
  protected readonly directOnly = signal(false);
  /** Phone only — the sidebar is always shown from `lg` up. */
  protected readonly filtersOpen = signal(false);

  protected readonly results = signal<TripSearchResultRow[] | null>(null);
  protected readonly searchError = signal<string | null>(null);
  protected readonly searching = signal(false);

  /** What the passenger asked for, read once from the URL — shown above
   * the results so a passenger who followed a link (or came back to a
   * bookmark) sees what it searched for, not just an unlabelled list. */
  protected readonly origin = signal('');
  protected readonly destination = signal('');
  protected readonly serviceDate = signal('');
  protected readonly tripClass = signal('');

  protected readonly activeFilterCount = computed(
    () =>
      this.selectedOperators().size +
      this.selectedClasses().size +
      this.selectedTimes().size +
      (this.directOnly() ? 1 : 0)
  );

  protected readonly filteredResults = computed<TripSearchResultRow[] | null>(() => {
    const rows = this.results();
    if (rows === null) {
      return null;
    }
    const operators = this.selectedOperators();
    const classes = this.selectedClasses();
    const times = this.selectedTimes();
    const directOnly = this.directOnly();
    return rows.filter(
      (row) =>
        (operators.size === 0 || operators.has(row.business_name)) &&
        (classes.size === 0 || classes.has(row.trip.trip_class ?? '')) &&
        (times.size === 0 || times.has(timeBucket(row.trip.scheduled_departure_at))) &&
        (!directOnly || row.stops_between === 0)
    );
  });

  /** One row per operator in the unfiltered results, cheapest first
   * within count — so the sidebar never offers an operator with nothing
   * to show, and each carries its lowest fare the way Wakanow's airline
   * filter does. */
  protected readonly operatorOptions = computed(() => {
    const byName = new Map<string, { name: string; count: number; minFare: number; currency: string }>();
    for (const row of this.results() ?? []) {
      const amount = Number(row.fare.amount);
      const existing = byName.get(row.business_name);
      if (existing) {
        existing.count += 1;
        existing.minFare = Math.min(existing.minFare, amount);
      } else {
        byName.set(row.business_name, { name: row.business_name, count: 1, minFare: amount, currency: row.fare.currency });
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  protected readonly classOptions = computed(() => {
    const counts = new Map<string, number>();
    for (const row of this.results() ?? []) {
      const value = row.trip.trip_class ?? '';
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([value]) => value !== '')
      .map(([value, count]) => ({ value, label: tripClassLabel(value), count }));
  });

  protected readonly timeCounts = computed(() => {
    const counts: Record<TimeBucket, number> = { morning: 0, afternoon: 0, evening: 0 };
    for (const row of this.results() ?? []) {
      counts[timeBucket(row.trip.scheduled_departure_at)] += 1;
    }
    return counts;
  });

  protected readonly directCount = computed(
    () => (this.results() ?? []).filter((row) => row.stops_between === 0).length
  );

  /** The best value each sort tab would put first, over what is
   * currently filtered — shown under the tab label. */
  protected readonly sortHighlights = computed(() => {
    const rows = this.filteredResults() ?? [];
    if (rows.length === 0) {
      return { departure: null, price: null, duration: null };
    }
    const earliest = rows.reduce((a, b) =>
      new Date(a.trip.scheduled_departure_at) <= new Date(b.trip.scheduled_departure_at) ? a : b
    );
    const cheapest = rows.reduce((a, b) => (Number(a.fare.amount) <= Number(b.fare.amount) ? a : b));
    const durations = rows.map((row) => row.duration_minutes).filter((m): m is number => m !== null);
    return {
      departure: earliest.trip.scheduled_departure_at,
      price: formatMoney(cheapest.fare.amount, cheapest.fare.currency),
      duration: durations.length ? formatDuration(Math.min(...durations)) : null,
    };
  });

  /** "Cheapest" / "Fastest" labels on the winning cards, over what is
   * currently filtered — Rome2Rio and Omio both mark these on the result
   * itself, not only in the sort control. None when there is nothing to
   * compare against, and "Fastest" only from known durations. Ties go to
   * every row that shares the best value. */
  protected readonly badges = computed(() => {
    const rows = this.filteredResults() ?? [];
    const badges = new Map<string, string[]>();
    if (rows.length < 2) {
      return badges;
    }
    const add = (row: TripSearchResultRow, label: string) => {
      const key = resultKey(row);
      badges.set(key, [...(badges.get(key) ?? []), label]);
    };
    const minFare = Math.min(...rows.map((row) => Number(row.fare.amount)));
    rows.filter((row) => Number(row.fare.amount) === minFare).forEach((row) => add(row, 'Cheapest'));
    const timed = rows.filter((row) => row.duration_minutes !== null);
    if (timed.length > 1) {
      const minDuration = Math.min(...timed.map((row) => row.duration_minutes as number));
      timed.filter((row) => row.duration_minutes === minDuration).forEach((row) => add(row, 'Fastest'));
    }
    return badges;
  });

  /** The searched day ±3, never before today (past days are omitted,
   * not disabled — nothing can be booked there). */
  protected readonly dateStrip = computed(() => {
    const current = this.serviceDate();
    if (!current) {
      return [];
    }
    const today = todayIso();
    const days: { value: string; date: Date }[] = [];
    for (let offset = -DATE_STRIP_RADIUS; offset <= DATE_STRIP_RADIUS; offset++) {
      const value = addDays(current, offset);
      if (value >= today) {
        days.push({ value, date: parseIsoDate(value) });
      }
    }
    return days;
  });

  protected readonly canGoToPreviousDay = computed(() => {
    const current = this.serviceDate();
    return current !== '' && current > todayIso();
  });

  protected readonly modifySearchParams = computed(() => ({
    origin: this.origin(),
    destination: this.destination(),
    service_date: this.serviceDate(),
    trip_class: this.tripClass() || undefined,
  }));

  protected readonly sortedResults = computed<TripSearchResultRow[] | null>(() => {
    const rows = this.filteredResults();
    if (rows === null) {
      return null;
    }
    const sorted = [...rows];
    const key = this.sortKey();
    if (key === 'price') {
      sorted.sort((a, b) => Number(a.fare.amount) - Number(b.fare.amount));
    } else if (key === 'duration') {
      // Unknown duration sorts last — it is not the same as "shortest",
      // and an operator who hasn't set one yet should not be rewarded
      // for it by floating to the top of a "shortest" sort.
      sorted.sort((a, b) => {
        if (a.duration_minutes === null && b.duration_minutes === null) {
          return 0;
        }
        if (a.duration_minutes === null) {
          return 1;
        }
        if (b.duration_minutes === null) {
          return -1;
        }
        return a.duration_minutes - b.duration_minutes;
      });
    } else {
      sorted.sort(
        (a, b) =>
          new Date(a.trip.scheduled_departure_at).getTime() -
          new Date(b.trip.scheduled_departure_at).getTime()
      );
    }
    return sorted;
  });

  ngOnInit(): void {
    this.route.queryParamMap.subscribe((params) => {
      const origin = params.get('origin') ?? '';
      const destination = params.get('destination') ?? '';
      const serviceDate = params.get('service_date') ?? '';
      const tripClass = params.get('trip_class') ?? undefined;
      this.origin.set(origin);
      this.destination.set(destination);
      this.serviceDate.set(serviceDate);
      this.tripClass.set(tripClass ?? '');
      if (origin && destination && serviceDate) {
        void this.search(origin, destination, serviceDate, tripClass);
      } else {
        this.searchError.set('This search link is missing something — try searching again.');
      }
    });
  }

  protected onSortChange(value: string): void {
    this.sortKey.set(value as SortKey);
  }

  protected toggleOperator(name: string): void {
    this.selectedOperators.update((set) => toggled(set, name));
  }

  protected toggleClass(value: string): void {
    this.selectedClasses.update((set) => toggled(set, value));
  }

  protected toggleTime(bucket: TimeBucket): void {
    this.selectedTimes.update((set) => toggled(set, bucket));
  }

  protected toggleDirectOnly(): void {
    this.directOnly.update((value) => !value);
  }

  protected clearFilters(): void {
    this.selectedOperators.set(new Set());
    this.selectedClasses.set(new Set());
    this.selectedTimes.set(new Set());
    this.directOnly.set(false);
  }

  protected toggleFiltersPanel(): void {
    this.filtersOpen.update((open) => !open);
  }

  /** Re-runs the search for another day by rewriting the URL — the
   * `queryParamMap` subscription does the fetch, so a date-strip click
   * is bookmarkable and Back-button-able like any other search. */
  protected async goToDate(value: string): Promise<void> {
    if (value === this.serviceDate() || value < todayIso()) {
      return;
    }
    await this.router.navigate(['/search/results'], {
      queryParams: { ...this.modifySearchParams(), service_date: value },
    });
  }

  protected async shiftDate(days: number): Promise<void> {
    await this.goToDate(addDays(this.serviceDate(), days));
  }

  protected dayClass(active: boolean): string {
    const base =
      'flex h-full w-full min-w-[4.5rem] flex-col items-center justify-center rounded-xl px-2 py-2 text-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
    return active ? `${base} bg-primary text-on-primary` : `${base} text-default hover:bg-surface-sunken`;
  }

  protected sortTabClass(active: boolean): string {
    const base =
      'relative flex min-h-16 flex-col items-center justify-center gap-0.5 border-r border-border px-2 py-2 text-center last:border-r-0 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';
    return active ? `${base} bg-primary-subtle` : `${base} hover:bg-surface-muted`;
  }

  protected badgesFor(result: TripSearchResultRow): string[] {
    return this.badges().get(resultKey(result)) ?? [];
  }

  protected initials(name: string): string {
    return operatorInitials(name);
  }

  protected avatarColour(name: string): string {
    return operatorColour(name);
  }

  protected formatFare(amount: number, currency: string): string {
    return formatMoney(amount.toFixed(2), currency);
  }

  protected async retry(): Promise<void> {
    const origin = this.origin();
    const destination = this.destination();
    const serviceDate = this.serviceDate();
    if (origin && destination && serviceDate) {
      await this.search(origin, destination, serviceDate, this.tripClass() || undefined);
    }
  }

  protected classLabel(value: string | undefined): string {
    return tripClassLabel(value);
  }

  protected fareLabel(result: TripSearchResultRow): string {
    return formatMoney(result.fare.amount, result.fare.currency);
  }

  protected stopsLabel(stopsBetween: number): string {
    return stopsBetween === 0 ? 'Direct' : plural(stopsBetween, 'stop');
  }

  protected durationLabel(result: TripSearchResultRow): string | null {
    return result.duration_minutes === null ? null : formatDuration(result.duration_minutes);
  }

  /** "3 seats left" — docs/specs/22-marketplace.md slice 3. `null` means
   * unlimited-or-unknowable (`Bookability.capacity_remaining`'s own
   * widened meaning), so nothing is shown rather than a misleading
   * "0 seats left" or an invented cap. */
  protected capacityLabel(result: TripSearchResultRow): string | null {
    return result.capacity_remaining === null ? null : `${plural(result.capacity_remaining, 'seat')} left`;
  }

  protected departureCountLabel(): string {
    const total = this.results()?.length ?? 0;
    const shown = this.filteredResults()?.length ?? 0;
    return shown === total
      ? `${plural(total, 'departure')} available`
      : `Showing ${shown} of ${plural(total, 'departure')}`;
  }

  protected chooseLabel(result: TripSearchResultRow): string {
    const time = new Date(result.trip.scheduled_departure_at).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    const serviceClass = tripClassLabel(result.trip.trip_class);
    const service = serviceClass ? `${serviceClass} ` : '';
    return `Book ${result.business_name}'s ${time} ${service}departure from ${result.from_stop.name} to ${result.to_stop.name}`;
  }

  private async search(
    origin: string,
    destination: string,
    serviceDate: string,
    tripClass: string | undefined
  ): Promise<void> {
    this.searching.set(true);
    this.searchError.set(null);
    this.clearFilters();
    this.filtersOpen.set(false);
    const { data, error } = await this.api.GET('/api/v1/marketplace/trips/search/', {
      params: {
        query: {
          origin,
          destination,
          service_date: serviceDate,
          ...(tripClass ? { trip_class: tripClass } : {}),
          limit: 100,
          offset: 0,
        },
      },
    });
    this.searching.set(false);
    if (!data) {
      this.searchError.set(toErrorMessage(error, 'Could not search trips. Try again.'));
      return;
    }
    this.results.set(data.results);
  }

  protected async selectTrip(result: TripSearchResultRow): Promise<void> {
    const trip: Trip = result.trip;
    const state: SeatPickerRequest = {
      tripId: trip.id,
      routeName: `${result.business_name} · ${trip.route.name}`,
      serviceDate: trip.service_date,
      scheduledDepartureAt: trip.scheduled_departure_at,
      fromStop: { id: result.from_stop.id, name: result.from_stop.name },
      toStop: { id: result.to_stop.id, name: result.to_stop.name },
      tripClass: trip.trip_class,
    };
    await this.router.navigate(['/search/seats'], { state });
  }
}
