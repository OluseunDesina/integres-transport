import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, EmptyState, Select, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import type { SeatPickerRequest } from '../shared/booking-draft';

type RouteBrowse = components['schemas']['RouteBrowse'];
type RouteStopEntry = components['schemas']['RouteStopEntry'];
type Trip = components['schemas']['Trip'];

const PICK_ROUTE_OPTION: SelectOption = { value: '', label: 'Select a route' };
const PICK_STOP_OPTION: SelectOption = { value: '', label: 'Select a stop' };

// Every Route the browse endpoint returns is guaranteed to have >=2
// active stops (backend enforces it), so a page of routes is small and
// bounded — one unpaginated fetch is correct here rather than a
// ListStore. Same for a single route+date's departures.
const MAX_OPTIONS = 100;

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
  imports: [DatePipe, FormsModule, Alert, Button, EmptyState, Select, TextField],
  templateUrl: './trip-search.html',
})
export class TripSearch implements OnInit {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);

  private readonly routes = signal<RouteBrowse[]>([]);
  protected readonly routesError = signal<string | null>(null);
  protected readonly loadingRoutes = signal(false);

  protected readonly routeId = signal('');
  protected readonly fromStopId = signal('');
  protected readonly toStopId = signal('');
  protected readonly serviceDate = signal('');

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

  protected readonly canSearch = computed(
    () =>
      this.routeId() !== '' &&
      this.fromStopId() !== '' &&
      this.toStopId() !== '' &&
      this.serviceDate() !== ''
  );

  async ngOnInit(): Promise<void> {
    await this.loadRoutes();
  }

  protected onRouteChange(value: string): void {
    this.routeId.set(value);
    // Stops belong to the Route that was just replaced — keeping them
    // would leave a segment pointing at another Route's stops.
    this.fromStopId.set('');
    this.toStopId.set('');
    this.trips.set(null);
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
    const { data, error } = await this.api.GET('/api/v1/routes/browse/', {
      params: { query: { limit: MAX_OPTIONS, offset: 0 } },
      headers: this.authHeader(),
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
    const { data, error } = await this.api.GET('/api/v1/trips/search/', {
      params: {
        query: {
          route: this.routeId(),
          service_date: this.serviceDate(),
          limit: MAX_OPTIONS,
          offset: 0,
        },
      },
      headers: this.authHeader(),
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
    };
    await this.router.navigate(['/search/seats'], { state });
  }

  private authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.authStore.accessToken()}` };
  }
}

function toStopOption(stop: RouteStopEntry): SelectOption {
  return { value: stop.id, label: `${stop.sequence}. ${stop.name}` };
}
