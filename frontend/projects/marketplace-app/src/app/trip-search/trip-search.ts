import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { Icon } from '@shared-ui';
import type { IconName, SelectOption } from '@shared-ui';

import { addDays, todayIso } from '../shared/dates';
import { type RecentSearch, readRecentSearches, saveRecentSearch, searchDateFor } from '../shared/recent-searches';
import { ALL_TRIP_CLASSES, tripClassFilterOptions } from '../shared/trip-class';

type StopSuggestRow = components['schemas']['StopSuggest'];

const SEARCH_DEBOUNCE_MS = 300;

/**
 * One origin/destination suggestion field. Identical shape to
 * `customer-app`'s own `StopCombobox` (see that file's docstring for
 * the full reasoning) — duplicated here rather than shared, per
 * docs/specs/22-marketplace.md's own "prove the marketplace UX first,
 * extract later" call.
 */
class StopCombobox {
  readonly query = signal('');
  readonly suggestions = signal<StopSuggestRow[]>([]);
  readonly open = signal(false);
  readonly loading = signal(false);
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly fetchSuggestions: (term: string) => Promise<StopSuggestRow[]>) {}

  onFocus(): void {
    this.open.set(true);
    if (this.suggestions().length === 0) {
      void this.load(this.query());
    }
  }

  onInput(value: string): void {
    this.query.set(value);
    this.open.set(true);
    if (this.debounceHandle !== null) {
      clearTimeout(this.debounceHandle);
    }
    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = null;
      void this.load(value);
    }, SEARCH_DEBOUNCE_MS);
  }

  select(row: StopSuggestRow): void {
    this.query.set(row.name);
    this.open.set(false);
  }

  /** Sets the text without opening the list or fetching — for a
   * prefill from the URL or a swap, where nothing was typed. */
  setQuery(value: string): void {
    this.query.set(value);
    this.suggestions.set([]);
  }

  close(): void {
    this.open.set(false);
  }

  destroy(): void {
    if (this.debounceHandle !== null) {
      clearTimeout(this.debounceHandle);
    }
  }

  private async load(term: string): Promise<void> {
    this.loading.set(true);
    const results = await this.fetchSuggestions(term);
    this.loading.set(false);
    this.suggestions.set(results);
  }
}

/**
 * The marketplace's search landing screen — docs/adr/0009,
 * docs/specs/22-marketplace.md, redesigned as a storefront by
 * docs/specs/24-marketplace-redesign.md (hero, overlapping search card,
 * how-it-works). Prefills from `origin`/`destination`/`service_date`/
 * `trip_class` query params, which is how the results page's "Modify
 * search" returns here without losing the search. The search form only: results
 * moved to their own route (`search-results.ts`) in slice 2, so a
 * passenger can filter/sort them, bookmark a search, and refresh
 * without losing it — none of which a results block living in this
 * same component's state could do.
 *
 * Calls the marketplace's own `/api/v1/marketplace/stops/suggest/`, not
 * the plain `/api/v1/stops/suggest/` — that one is scoped to the
 * signed-in passenger's own Client, and a marketplace passenger's own
 * Client (the platform's Marketplace Client) owns no routes at all.
 * Public — a guest can search with no session (docs/specs/22-marketplace.md
 * slice 2, `app.routes.ts`).
 */
@Component({
  selector: 'app-trip-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, Icon],
  templateUrl: './trip-search.html',
})
export class TripSearch {
  private readonly api = inject(API_CLIENT);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  /** A bordered box on its own below `lg`; from `lg` up the bar draws the
   * outline and each segment only needs a hover/focus state. */
  protected readonly fieldBoxClass =
    'flex min-h-16 flex-col justify-center gap-0.5 rounded-xl border border-control bg-surface px-3 py-2 transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 lg:h-full lg:border-0 lg:hover:bg-surface-muted lg:focus-within:ring-inset';
  protected readonly fieldLabelClass = 'text-[11px] font-semibold tracking-wider text-muted uppercase';
  protected readonly fieldInputClass =
    'w-full min-w-0 border-0 bg-transparent p-0 text-base font-medium text-strong placeholder:font-normal placeholder:text-muted focus:outline-none';
  protected readonly listboxClass =
    'absolute top-full z-20 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-border bg-surface py-1 shadow-lg';
  protected readonly optionClass =
    'flex cursor-pointer items-center gap-2 px-4 py-2.5 text-sm text-default hover:bg-primary-subtle hover:text-strong';

  protected readonly today = todayIso();
  protected readonly quickDates = [
    { label: 'Today', value: this.today },
    { label: 'Tomorrow', value: addDays(this.today, 1) },
  ];

  /** Each one true today — docs/specs/24-marketplace-redesign.md's
   * "trust strip claims" edge case. No counts or ratings: we have none. */
  protected readonly trustPoints: { icon: IconName; label: string }[] = [
    { icon: 'squares-2x2', label: 'Every operator in one search' },
    { icon: 'check', label: 'Choose your own seat' },
    { icon: 'ticket', label: 'QR e-ticket on your phone' },
  ];

  protected readonly steps: { icon: IconName; title: string; body: string }[] = [
    {
      icon: 'magnifying-glass',
      title: 'Search every operator',
      body: 'Tell us where and when. We line up departures from every operator on the route, side by side.',
    },
    {
      icon: 'squares-2x2',
      title: 'Pick your seat',
      body: 'Compare times, class and price, then choose exactly where you sit on the seat map.',
    },
    {
      icon: 'ticket',
      title: 'Pay and board',
      body: 'Pay by card, transfer or wallet. Your QR ticket is ready to scan at boarding.',
    },
  ];

  protected readonly fromField = new StopCombobox((term) => this.suggestStops(term));
  protected readonly toField = new StopCombobox((term) => this.suggestStops(term));

  protected readonly serviceDate = signal('');
  protected readonly tripClass = signal(ALL_TRIP_CLASSES);

  protected readonly tripClassOptions: SelectOption[] = tripClassFilterOptions([]);

  protected readonly canSearch = computed(
    () =>
      this.fromField.query().trim() !== '' &&
      this.toField.query().trim() !== '' &&
      this.serviceDate() !== ''
  );

  protected readonly recentSearches = signal<RecentSearch[]>(readRecentSearches());

  protected chipClass(active: boolean): string {
    const base =
      'inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
    return active
      ? `${base} border-primary bg-primary-subtle text-primary`
      : `${base} border-border text-default hover:border-control hover:text-strong`;
  }

  protected recentQueryParams(recent: RecentSearch): Record<string, string | undefined> {
    return {
      origin: recent.origin,
      destination: recent.destination,
      service_date: searchDateFor(recent),
      trip_class: recent.tripClass || undefined,
    };
  }

  constructor() {
    const params = this.route.snapshot.queryParamMap;
    this.fromField.setQuery(params.get('origin') ?? '');
    this.toField.setQuery(params.get('destination') ?? '');
    this.serviceDate.set(params.get('service_date') ?? '');
    this.tripClass.set(params.get('trip_class') ?? ALL_TRIP_CLASSES);

    this.destroyRef.onDestroy(() => {
      this.fromField.destroy();
      this.toField.destroy();
    });
  }

  protected onFromInput(value: string): void {
    this.fromField.onInput(value);
  }

  protected onToInput(value: string): void {
    this.toField.onInput(value);
  }

  protected selectFromSuggestion(row: StopSuggestRow): void {
    this.fromField.select(row);
  }

  protected selectToSuggestion(row: StopSuggestRow): void {
    this.toField.select(row);
  }

  protected swap(): void {
    const from = this.fromField.query();
    this.fromField.setQuery(this.toField.query());
    this.toField.setQuery(from);
  }

  protected onServiceDateChange(value: string): void {
    this.serviceDate.set(value);
  }

  protected onTripClassChange(value: string): void {
    this.tripClass.set(value);
  }

  private async suggestStops(term: string): Promise<StopSuggestRow[]> {
    const { data } = await this.api.GET('/api/v1/marketplace/stops/suggest/', {
      params: { query: { q: term.trim() || undefined } },
    });
    return data ?? [];
  }

  protected async search(): Promise<void> {
    if (!this.canSearch()) {
      return;
    }
    const tripClass = this.tripClass();
    saveRecentSearch({
      origin: this.fromField.query().trim(),
      destination: this.toField.query().trim(),
      serviceDate: this.serviceDate(),
      tripClass,
    });
    await this.router.navigate(['/search/results'], {
      queryParams: {
        origin: this.fromField.query().trim(),
        destination: this.toField.query().trim(),
        service_date: this.serviceDate(),
        trip_class: tripClass || undefined,
      },
    });
  }
}
