import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { Alert, Button, EmptyState, PageHeader, Select, Skeleton, StatusPill } from '@shared-ui';
import type { SelectOption } from '@shared-ui';
import { plural } from '@shared-ui';

import { BookingSteps } from '../shared/booking-steps';
import type { SeatPickerRequest } from '../shared/booking-draft';
import { formatMoney } from '../shared/money';
import { ALL_TRIP_CLASSES, tripClassFilterOptions, tripClassLabel } from '../shared/trip-class';

type StopSuggestRow = components['schemas']['StopSuggest'];
type TripSearchResultRow = components['schemas']['TripSearchResult'];
type Trip = components['schemas']['Trip'];

// One page is enough for now: this screen has no "load more" affordance.
// A single origin/destination/date search matching more than 100
// route-and-stop combinations in one day is not a case seeded data or
// real operators have hit yet — revisit if that changes.
const SEARCH_RESULTS_LIMIT = 100;

// Debounced here rather than by a shared component: this screen has
// exactly two suggestion inputs, each wired to its own signal, and
// pulling in `ui-filter-bar` (built for a list/table's chips and
// multi-filter bar) for either would be more machinery than the problem
// needs.
const SEARCH_DEBOUNCE_MS = 300;

function toErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return fallback;
}

/**
 * One origin/destination suggestion field — "From" and "To" each get
 * their own instance. Not a `shared-ui` primitive (see this file's own
 * doc comment): this is the one place in the app that needs a
 * text-input-with-dropdown, and its shape (debounced fetch, default
 * list on focus, click-to-select) is entirely local to this screen.
 *
 * Selecting a suggestion only fills the input with that Stop's exact
 * name — there is no id to carry forward. `GET /trips/search/` matches
 * `origin`/`destination` as free text (case-insensitive, partial), and
 * each *result* row already carries the specific `from_stop`/`to_stop`
 * it matched against (`apps.network.services.find_route_stop_matches`
 * can match one search term to more than one physical Stop), so that is
 * where a real Stop id belongs — not on the query itself.
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
 * Passenger trip search — docs/specs/4-fares-seating-booking-frontend.md
 * §3.3 (reworked). Entry point of the booking flow: type where you're
 * travelling from and to, then a date, then choose a departure.
 *
 * Reworked from a Route-first flow (pick a Route, then its own From/To
 * stops) to source/destination text search, matching the flow the user
 * asked for after reviewing Wakanow's flight search: `GET
 * /stops/suggest/` backs the From/To typeahead, and `GET
 * /trips/search/` resolves origin/destination text directly to bookable
 * Trips — the app finds which Route(s) connect the two points, rather
 * than requiring the passenger already know.
 */
@Component({
  selector: 'app-trip-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    BookingSteps,
    Alert,
    Button,
    EmptyState,
    PageHeader,
    Select,
    Skeleton,
    StatusPill,
  ],
  templateUrl: './trip-search.html',
})
export class TripSearch {
  private readonly api = inject(API_CLIENT);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly fromField = new StopCombobox((term) => this.suggestStops(term));
  protected readonly toField = new StopCombobox((term) => this.suggestStops(term));

  protected readonly serviceDate = signal('');
  protected readonly tripClass = signal(ALL_TRIP_CLASSES);

  protected readonly results = signal<TripSearchResultRow[] | null>(null);
  protected readonly searchError = signal<string | null>(null);
  protected readonly searching = signal(false);

  protected readonly tripClassOptions: SelectOption[] = tripClassFilterOptions([]);

  protected readonly canSearch = computed(
    () =>
      this.fromField.query().trim() !== '' &&
      this.toField.query().trim() !== '' &&
      this.serviceDate() !== ''
  );

  constructor() {
    // A pending debounce after the screen is gone would fetch into a
    // destroyed component.
    this.destroyRef.onDestroy(() => {
      this.fromField.destroy();
      this.toField.destroy();
    });
  }

  protected onFromInput(value: string): void {
    this.fromField.onInput(value);
    this.results.set(null);
  }

  protected onToInput(value: string): void {
    this.toField.onInput(value);
    this.results.set(null);
  }

  protected selectFromSuggestion(row: StopSuggestRow): void {
    this.fromField.select(row);
    this.results.set(null);
  }

  protected selectToSuggestion(row: StopSuggestRow): void {
    this.toField.select(row);
    this.results.set(null);
  }

  protected onServiceDateChange(value: string): void {
    this.serviceDate.set(value);
    this.results.set(null);
  }

  protected onTripClassChange(value: string): void {
    this.tripClass.set(value);
    this.results.set(null);
  }

  protected classLabel(value: string | undefined): string {
    return tripClassLabel(value);
  }

  protected fareLabel(result: TripSearchResultRow): string {
    return formatMoney(result.fare.amount, result.fare.currency);
  }

  /** "Direct" for a zero-stop match, per the user's own wording; a
   * count otherwise. */
  protected stopsLabel(stopsBetween: number): string {
    return stopsBetween === 0 ? 'Direct' : plural(stopsBetween, 'stop');
  }

  protected departureCountLabel(): string {
    const count = this.results()?.length ?? 0;
    return `${plural(count, 'departure')} available`;
  }

  /**
   * The accessible name for a row's Continue button.
   *
   * Every card can render the same visible word, and — now that a
   * single search can return the same departure matched against more
   * than one stop pair — even the same route and time can repeat, so
   * the stop pair is part of the name too, not only the class.
   */
  protected chooseLabel(result: TripSearchResultRow): string {
    const time = new Date(result.trip.scheduled_departure_at).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    const serviceClass = tripClassLabel(result.trip.trip_class);
    const service = serviceClass ? `${serviceClass} ` : '';
    return `Continue with the ${time} ${service}departure from ${result.from_stop.name} to ${result.to_stop.name}`;
  }

  private async suggestStops(term: string): Promise<StopSuggestRow[]> {
    const { data } = await this.api.GET('/api/v1/stops/suggest/', {
      params: { query: { q: term.trim() || undefined } },
    });
    return data ?? [];
  }

  protected async search(): Promise<void> {
    if (!this.canSearch()) {
      return;
    }
    this.searching.set(true);
    this.searchError.set(null);
    const tripClass = this.tripClass();
    const { data, error } = await this.api.GET('/api/v1/trips/search/', {
      params: {
        query: {
          origin: this.fromField.query().trim(),
          destination: this.toField.query().trim(),
          service_date: this.serviceDate(),
          // Omitted rather than sent empty when the passenger has not
          // narrowed: `trip_class` is a ChoiceField, so `''` is a 400,
          // not "no filter".
          ...(tripClass ? { trip_class: tripClass } : {}),
          limit: SEARCH_RESULTS_LIMIT,
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
      routeName: trip.route.name,
      serviceDate: trip.service_date,
      scheduledDepartureAt: trip.scheduled_departure_at,
      fromStop: { id: result.from_stop.id, name: result.from_stop.name },
      toStop: { id: result.to_stop.id, name: result.to_stop.name },
      tripClass: trip.trip_class,
    };
    await this.router.navigate(['/search/seats'], { state });
  }
}
