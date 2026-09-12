import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import {
  Alert,
  Button,
  EmptyState,
  PageHeader,
  Select,
  Skeleton,
  StatusPill,
  TextField,
} from '@shared-ui';
import type { SelectOption } from '@shared-ui';
import { plural } from '@shared-ui';

import { BookingSteps } from '../shared/booking-steps';
import type { SeatPickerRequest } from '../shared/booking-draft';
import { ALL_TRIP_CLASSES, tripClassFilterOptions, tripClassLabel } from '../shared/trip-class';

type RouteBrowse = components['schemas']['RouteBrowse'];
type RouteStopEntry = components['schemas']['RouteStopEntry'];
type Trip = components['schemas']['Trip'];

const PICK_ROUTE_OPTION: SelectOption = { value: '', label: 'Select a route' };
const PICK_STOP_OPTION: SelectOption = { value: '', label: 'Select a stop' };

// Every Route the browse endpoint returns is guaranteed to have >=2
// active stops (backend enforces it), so *for a single route+date's
// departures* a page is small and bounded — one unpaginated fetch is
// correct there rather than a ListStore. The route list itself is a
// different claim: a Client can run more than this many routes, and an
// unfiltered top-100 silently hid any route past that cap (self-check
// 2026-09-12-specs19-21). `?search=` (added to the same request) is
// what keeps this cap safe rather than removing it — a real search
// term narrows the match set well under 100 regardless of how many
// routes exist in total.
const MAX_OPTIONS = 100;

// Debounced here rather than by a shared component: this screen has
// exactly one search box, wired to a single signal, and pulling in
// `ui-filter-bar` (built for a list/table's chips and multi-filter
// bar) for one input would be more machinery than the problem needs.
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
 * Passenger trip search — docs/specs/4-fares-seating-booking-frontend.md
 * §4.3. Entry point of the booking flow: pick a Route, a boarding and
 * alighting Stop, and a date, then choose a departure.
 *
 * Routes come from `GET /routes/browse/`, whose rows already embed their
 * ordered stops — so the from/to pickers need no second request, which
 * is exactly why that endpoint embeds them (§3.2).
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
    TextField,
  ],
  templateUrl: './trip-search.html',
})
export class TripSearch implements OnInit {
  private readonly api = inject(API_CLIENT);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  private readonly routes = signal<RouteBrowse[]>([]);
  protected readonly routesError = signal<string | null>(null);
  protected readonly loadingRoutes = signal(false);
  protected readonly routeSearchTerm = signal('');
  private searchDebounceHandle: ReturnType<typeof setTimeout> | null = null;

  protected readonly routeId = signal('');
  protected readonly fromStopId = signal('');
  protected readonly toStopId = signal('');
  protected readonly serviceDate = signal('');
  protected readonly tripClass = signal(ALL_TRIP_CLASSES);

  protected readonly trips = signal<Trip[] | null>(null);
  protected readonly searchError = signal<string | null>(null);
  protected readonly searching = signal(false);

  private readonly selectedRoute = computed(
    () => this.routes().find((route) => route.id === this.routeId()) ?? null
  );

  // A Client can run several Businesses (§3.2's DECISION), and this
  // endpoint spans all of them — so each option says which operator it
  // belongs to, but only when there's actually more than one to
  // disambiguate. Labelling every row with the same operator name on a
  // single-Business Client would be noise.
  protected readonly routeOptions = computed<SelectOption[]>(() => {
    const routes = this.routes();
    const multipleBusinesses = new Set(routes.map((route) => route.business.id)).size > 1;
    return [
      PICK_ROUTE_OPTION,
      ...routes.map((route) => ({
        value: route.id,
        label: multipleBusinesses ? `${route.name} — ${route.business.name}` : route.name,
      })),
    ];
  });

  protected readonly fromStopOptions = computed<SelectOption[]>(() => [
    PICK_STOP_OPTION,
    ...(this.selectedRoute()?.stops ?? []).map(toStopOption),
  ]);

  // The backend rejects a segment whose to_stop isn't after its
  // from_stop (`BookingCreateSerializer.validate()`'s
  // `invalid_segment_order`). Filtering the options here means that
  // rejection is unreachable from the UI rather than surfaced as a 400
  // after the passenger has already picked seats.
  protected readonly toStopOptions = computed<SelectOption[]>(() => {
    const stops = this.selectedRoute()?.stops ?? [];
    const from = stops.find((stop) => stop.id === this.fromStopId());
    if (!from) {
      return [PICK_STOP_OPTION];
    }
    return [
      PICK_STOP_OPTION,
      ...stops.filter((stop) => stop.sequence > from.sequence).map(toStopOption),
    ];
  });

  /**
   * The class filter, narrowed to what the chosen route actually runs
   * — `available_trip_classes` is already in the browse response
   * (`RouteBrowseSerializer` extends `RouteSerializer`), so this costs
   * no request. An empty allow-list means no restriction, so a route
   * predating spec 15 still offers all four.
   *
   * Narrowing without reconciling is the trap spec 15 slice 2 recorded:
   * a control still holding `premium` against a Standard-only route
   * renders a `<select>` with no matching `<option>` — it looks empty,
   * keeps its value, and searches for departures that cannot exist.
   * Here the class is cleared in `onRouteChange` alongside the stops,
   * for exactly the reason they are: they belong to the route that was
   * just replaced. That is simpler than slice 2's reconciliation
   * `effect` and sufficient, because a route change is the only thing
   * that narrows this list.
   */
  protected readonly tripClassOptions = computed<SelectOption[]>(() =>
    tripClassFilterOptions(this.selectedRoute()?.available_trip_classes ?? [])
  );

  protected readonly canSearch = computed(
    () =>
      this.routeId() !== '' &&
      this.fromStopId() !== '' &&
      this.toStopId() !== '' &&
      this.serviceDate() !== ''
  );

  constructor() {
    // A pending debounce after the screen is gone would fetch into a
    // destroyed component.
    this.destroyRef.onDestroy(() => {
      if (this.searchDebounceHandle !== null) {
        clearTimeout(this.searchDebounceHandle);
      }
    });
  }

  async ngOnInit(): Promise<void> {
    await this.loadRoutes();
  }

  protected onRouteSearchInput(value: string): void {
    this.routeSearchTerm.set(value);
    if (this.searchDebounceHandle !== null) {
      clearTimeout(this.searchDebounceHandle);
    }
    this.searchDebounceHandle = setTimeout(() => {
      this.searchDebounceHandle = null;
      void this.loadRoutes();
    }, SEARCH_DEBOUNCE_MS);
  }

  protected departureCountLabel(): string {
    const results = this.trips() ?? [];
    return `${plural(results.length, 'departure')} available`;
  }

  /**
   * The accessible name for a row's Continue button.
   *
   * Every card renders the same visible word, so without this a screen
   * reader announces "Continue, button" a dozen times with nothing to
   * tell them apart — the same defect `ui-button.ariaLabel` was added
   * for on the KYB screen's six Upload buttons. Starts with "Continue"
   * so the visible label is the first thing announced, and so a
   * `getByRole('button', { name: 'Continue' })` still matches it.
   */
  protected chooseLabel(trip: Trip): string {
    const time = new Date(trip.scheduled_departure_at).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    // The class is in the name because it is a real differentiator
    // between two rows of this list: one route can run a Premium and a
    // Standard departure minutes apart at different prices, and the
    // pill that says so is not part of this button's accessible name.
    const serviceClass = tripClassLabel(trip.trip_class);
    const service = serviceClass ? `${serviceClass} ` : '';
    return `Continue with the ${time} ${service}${trip.route.name} departure`;
  }

  protected onRouteChange(value: string): void {
    this.routeId.set(value);
    // Stops belong to the Route that was just replaced — keeping them
    // would leave a segment pointing at another Route's stops. The
    // class goes with them for the same reason: the new route may not
    // run it (see `tripClassOptions`).
    this.fromStopId.set('');
    this.toStopId.set('');
    this.tripClass.set(ALL_TRIP_CLASSES);
    this.trips.set(null);
  }

  protected onTripClassChange(value: string): void {
    this.tripClass.set(value);
    this.trips.set(null);
  }

  protected classLabel(value: string | undefined): string {
    return tripClassLabel(value);
  }

  protected onFromStopChange(value: string): void {
    this.fromStopId.set(value);
    // The to-stop options are recomputed relative to this one, so a
    // previously valid choice may no longer be after it.
    this.toStopId.set('');
    this.trips.set(null);
  }

  protected onToStopChange(value: string): void {
    this.toStopId.set(value);
    this.trips.set(null);
  }

  protected onServiceDateChange(value: string): void {
    this.serviceDate.set(value);
    this.trips.set(null);
  }

  protected async loadRoutes(): Promise<void> {
    this.loadingRoutes.set(true);
    this.routesError.set(null);
    const search = this.routeSearchTerm().trim();
    const { data, error } = await this.api.GET('/api/v1/routes/browse/', {
      params: { query: { limit: MAX_OPTIONS, offset: 0, search: search || undefined } },
    });
    this.loadingRoutes.set(false);
    if (!data) {
      this.routesError.set(toErrorMessage(error, 'Could not load routes. Try again.'));
      return;
    }
    this.routes.set(data.results);
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
          route: this.routeId(),
          service_date: this.serviceDate(),
          // Omitted rather than sent empty when the passenger has not
          // narrowed: `trip_class` is a ChoiceField, so `''` is a 400,
          // not "no filter".
          ...(tripClass ? { trip_class: tripClass } : {}),
          limit: MAX_OPTIONS,
          offset: 0,
        },
      },
    });
    this.searching.set(false);
    if (!data) {
      this.searchError.set(toErrorMessage(error, 'Could not search trips. Try again.'));
      return;
    }
    this.trips.set(data.results);
  }

  protected async selectTrip(trip: Trip): Promise<void> {
    const stops = this.selectedRoute()?.stops ?? [];
    const fromStop = stops.find((stop) => stop.id === this.fromStopId());
    const toStop = stops.find((stop) => stop.id === this.toStopId());
    if (!fromStop || !toStop) {
      return;
    }
    const state: SeatPickerRequest = {
      tripId: trip.id,
      routeName: trip.route.name,
      serviceDate: trip.service_date,
      scheduledDepartureAt: trip.scheduled_departure_at,
      fromStop: { id: fromStop.id, name: fromStop.name },
      toStop: { id: toStop.id, name: toStop.name },
      tripClass: trip.trip_class,
    };
    await this.router.navigate(['/search/seats'], { state });
  }
}

function toStopOption(stop: RouteStopEntry): SelectOption {
  return { value: stop.id, label: `${stop.sequence}. ${stop.name}` };
}
