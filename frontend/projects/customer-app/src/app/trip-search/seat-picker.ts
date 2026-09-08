import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { FormsModule } from '@angular/forms';
import { Alert, Button, EmptyState, PageHeader, Select, Skeleton, plural } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { BookingSteps } from '../shared/booking-steps';
import type { BookingRequest, SeatPickerRequest } from '../shared/booking-draft';
import { readSeatPickerRequest } from '../shared/booking-draft';
import { formatMoney, multiplyDecimal } from '../shared/money';
import { tripClassLabel } from '../shared/trip-class';

type SeatAvailability = components['schemas']['SeatAvailability'];
type Bookability = components['schemas']['TripBookability'];

/** The most places one booking may buy when capacity is unlimited
 * (`capacity_enforced` off, so `capacity_remaining` is null). A cap has
 * to come from somewhere, and an unbounded number input on a phone is
 * an invitation to a typo that books forty seats. Operators who need
 * more than this take group bookings off-app. */
const UNLIMITED_PLACES_CAP = 10;

interface SeatRow {
  row: number | null;
  segments: SeatAvailability[][];
}

/**
 * Splits a row's seats (already sorted by column) into segments
 * wherever the stored `column` integer jumps by more than 1 — the
 * signal `apps.seating.services.generate_seat_layout`'s physical-layout
 * aisle model leaves behind (docs/specs/8-seat-map-generation.md's Edge
 * case §5). A row with no aisle is just one segment.
 */
function splitAtAisleGaps(seats: SeatAvailability[]): SeatAvailability[][] {
  const segments: SeatAvailability[][] = [];
  let current: SeatAvailability[] = [];
  let previousColumn: number | null = null;
  for (const entry of seats) {
    const column = entry.seat.column;
    if (previousColumn !== null && column !== null && column - previousColumn > 1) {
      segments.push(current);
      current = [];
    }
    current.push(entry);
    previousColumn = column;
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

/**
 * Orders seat numbers the way a person reads them: 1A, 1B, 2A … 10A.
 *
 * `numeric: true` is the whole point — a plain string compare puts 10A
 * before 2A, which is the second-most-common way to render a seat map
 * wrongly after not sorting it at all.
 */
const SEAT_NUMBER_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function bySeatNumber(a: SeatAvailability, b: SeatAvailability): number {
  return SEAT_NUMBER_COLLATOR.compare(a.seat.seat_number, b.seat.seat_number);
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

/**
 * Seat map for one Trip segment —
 * docs/specs/4-fares-seating-booking-frontend.md §4.3. Net-new
 * component: no seat-grid primitive exists anywhere in `shared-ui` or
 * any app, and per §4.4 this deliberately stays customer-app-local
 * rather than being promoted, since client-admin's own seat management
 * is a bulk-replace form with no map view.
 *
 * Availability is always fetched here, never carried forward from the
 * search screen — it is the most volatile thing in the flow, and a
 * segment-aware availability query (`?from_stop=&to_stop=`) is the only
 * thing that knows whether seat 4A is free for *this* leg range.
 *
 * **Two ways to buy, one screen** (docs/specs/10-booking-modes.md).
 * Either the passenger picks named seats, or they say how many places
 * they want — the latter covering both open seating and reservation
 * mode with seat choice turned off. Which one applies is answered by
 * the availability envelope (`booking_mode`, `seat_selection_enabled`),
 * never guessed from the seat list being empty.
 *
 * Three states are load-bearing rather than incidental:
 * - `not_configured` — nobody has assigned a vehicle yet. An operator
 *   fixes this; the passenger cannot.
 * - `sold_out` — genuinely full for this segment. Until slice 4 these
 *   two were rendered identically, because both arrived as an empty
 *   seat array; telling a passenger "sold out" about a departure with
 *   no bus assigned is the defect the envelope exists to fix.
 * - an unpriced segment 404s on the fare endpoint — shown as a blocking
 *   alert *before* anything is selectable, so a passenger never picks
 *   seats for a trip that cannot be priced.
 */
@Component({
  selector: 'app-seat-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    BookingSteps,
    Alert,
    Button,
    EmptyState,
    PageHeader,
    Select,
    Skeleton,
  ],
  templateUrl: './seat-picker.html',
})
export class SeatPicker implements OnInit {
  private readonly api = inject(API_CLIENT);
  private readonly router = inject(Router);

  protected readonly request = signal<SeatPickerRequest | null>(readSeatPickerRequest(this.router));

  protected readonly loading = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly fareError = signal<string | null>(null);

  private readonly bookability = signal<Bookability | null>(null);
  private readonly farePerSeat = signal<string | null>(null);
  protected readonly currency = signal('');

  protected readonly selectedSeatIds = signal<ReadonlySet<string>>(new Set());
  protected readonly passengerCount = signal(1);

  private readonly availability = computed<SeatAvailability[]>(
    () => this.bookability()?.seats ?? []
  );

  protected readonly status = computed(() => this.bookability()?.status ?? null);
  protected readonly notConfigured = computed(() => this.status() === 'not_configured');
  protected readonly soldOut = computed(() => this.status() === 'sold_out');

  /** Why no seat is being chosen, which is **not** the same sentence
   * in the two cases that get here. Open seating assigns nobody a seat;
   * quick book assigns one, the passenger just does not pick it. Saying
   * "sit anywhere that's free" to a quick-book passenger who is holding
   * seat 3B would be plainly wrong. */
  protected readonly placesHint = computed(() =>
    this.bookability()?.booking_mode === 'open_seating'
      ? "Seats aren't assigned on this service — sit anywhere that's free."
      : 'This operator assigns seats for you — you just tell us how many.'
  );

  /** Asking "How many passengers?" above "Not open for booking yet"
   * reads as a broken screen — the question is only worth asking when
   * there is something to answer it about. */
  protected readonly heading = computed(() => {
    if (this.status() !== 'open') {
      return 'Your journey';
    }
    return this.buysPlaces() ? 'How many passengers?' : 'Choose your seats';
  });

  /** True when the passenger buys places rather than picking seats.
   * Read off the envelope, not inferred from an empty seat list — that
   * inference is exactly what conflated "sold out" with "no bus yet". */
  protected readonly buysPlaces = computed(() => {
    const bookability = this.bookability();
    return bookability !== null && !bookability.seat_selection_enabled;
  });

  /** Options for the "how many" control, capped by what is actually
   * left. Constrained rather than free text, matching this workspace's
   * standing preference for inputs that cannot express a wrong value. */
  protected readonly placeOptions = computed<number[]>(() => {
    const remaining = this.bookability()?.capacity_remaining;
    const seatsFree = this.availability().filter((entry) => entry.is_available).length;
    const cap =
      remaining ?? (this.bookability()?.booking_mode === 'open_seating' ? UNLIMITED_PLACES_CAP : seatsFree);
    return Array.from({ length: Math.max(Math.min(cap, UNLIMITED_PLACES_CAP), 1) }, (_, i) => i + 1);
  });

  /** `placeOptions` in the shape `ui-select` takes. The numbers stay the
   * source of truth — the cap arithmetic above is the part worth
   * testing, and it should not have to know about a UI type. */
  protected readonly placeSelectOptions = computed<SelectOption[]>(() =>
    this.placeOptions().map((count) => ({ value: String(count), label: String(count) }))
  );

  /** The journey itself, under the heading. Was three stacked lines of
   * muted text above the old hand-written `<h1>`; `ui-page-header` takes
   * one description, and the departure time belongs with the route
   * rather than on a line of its own. */
  /** The class this trip actually runs as, from the availability
   * envelope's own `trip_class` — never from `request().tripClass`.
   * This file's whole contract is that carried router state is not
   * trusted for correctness, and the envelope was fetched moments ago
   * (docs/specs/15-trip-classes.md slice 3). Blank until it arrives,
   * which keeps the journey line from flashing a stale class. */
  protected readonly serviceClass = computed(() =>
    tripClassLabel(this.bookability()?.trip_class)
  );

  protected readonly journeyLine = computed(() => {
    const journey = this.request();
    if (!journey) {
      return null;
    }
    const departs = new Date(journey.scheduledDepartureAt).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    const parts = [
      journey.routeName,
      `${journey.fromStop.name} to ${journey.toStop.name}`,
      `departs ${departs}`,
    ];
    const serviceClass = this.serviceClass();
    if (serviceClass) {
      parts.push(`${serviceClass} service`);
    }
    return parts.join(' · ');
  });

  /** "2 seats selected" / "3 passengers" — the count in words rather
   * than the old "seat(s)", which no one writes on purpose. */
  protected readonly selectionLabel = computed(() =>
    this.buysPlaces()
      ? plural(this.selectedCount(), 'passenger')
      : `${plural(this.selectedCount(), 'seat')} selected`
  );

  /**
   * Groups seats into rows when the VehicleType defines `row`/`column`
   * geometry, and falls back to a single wrapped row of seat numbers
   * when it doesn't — both are valid per the backend's own seat-map
   * non-goal, so neither can be treated as the broken case.
   */
  protected readonly seatRows = computed<SeatRow[]>(() => {
    const seats = this.availability();
    if (seats.every((entry) => entry.seat.row === null)) {
      // Sorted, because the response is not.
      // `apps.seating.services.get_availability` reads
      // `Seat.objects.filter(...)` with no `order_by`, so it inherits
      // `Seat.Meta.ordering = ["-created_at"]` and hands back the seats
      // **newest first** — a bus rendered 3B, 3A, 2B, 2A, 1B, 1A, which
      // is what iteration-15 photographed.
      //
      // The row/column path below is unaffected: it sorts rows and then
      // columns itself. Only this no-geometry fallback trusted the
      // order it was given.
      //
      // The root cause is that missing `order_by` — the same
      // `-created_at` trap spec 10 already recorded for quick-book seat
      // *allocation* and fixed there, without anyone checking the seat
      // map a passenger actually looks at. Fixed here rather than in
      // `get_availability` only because this slice makes no backend
      // change; the backend ordering is still worth correcting.
      return [{ row: null, segments: [[...seats].sort(bySeatNumber)] }];
    }
    const byRow = new Map<number | null, SeatAvailability[]>();
    for (const entry of seats) {
      const key = entry.seat.row;
      byRow.set(key, [...(byRow.get(key) ?? []), entry]);
    }
    return [...byRow.entries()]
      .sort((a, b) => (a[0] ?? Number.MAX_SAFE_INTEGER) - (b[0] ?? Number.MAX_SAFE_INTEGER))
      .map(([row, rowSeats]) => {
        const sorted = [...rowSeats].sort((a, b) => (a.seat.column ?? 0) - (b.seat.column ?? 0));
        return { row, segments: splitAtAisleGaps(sorted) };
      });
  });

  /** How many places this booking is for, in whichever way the
   * passenger expressed it — the one number the total is priced from,
   * so both modes share the money maths rather than duplicating it. */
  protected readonly selectedCount = computed(() =>
    this.buysPlaces() ? this.passengerCount() : this.selectedSeatIds().size
  );

  protected readonly totalLabel = computed(() => {
    const fare = this.farePerSeat();
    if (fare === null) {
      return null;
    }
    return formatMoney(multiplyDecimal(fare, this.selectedCount()), this.currency());
  });

  protected readonly fareLabel = computed(() => {
    const fare = this.farePerSeat();
    return fare === null ? null : formatMoney(fare, this.currency());
  });

  protected readonly canContinue = computed(
    () => this.selectedCount() > 0 && this.farePerSeat() !== null
  );

  async ngOnInit(): Promise<void> {
    // A passenger who deep-links or refreshes into a lost navigation
    // state has no segment to price or seat — start the flow over
    // rather than render a half-populated screen.
    if (!this.request()) {
      await this.router.navigate(['/search']);
      return;
    }
    await this.load();
  }

  protected async load(): Promise<void> {
    const request = this.request();
    if (!request) {
      return;
    }
    this.loading.set(true);
    this.loadError.set(null);
    this.fareError.set(null);
    this.selectedSeatIds.set(new Set());
    this.passengerCount.set(1);

    const path = { path: { id: request.tripId } };
    const query = { from_stop: request.fromStop.id, to_stop: request.toStop.id };

    const [availability, fare] = await Promise.all([
      this.api.GET('/api/v1/trips/{id}/availability/', { params: { ...path, query } }),
      this.api.GET('/api/v1/trips/{id}/fare/', { params: { ...path, query } }),
    ]);

    this.loading.set(false);

    if (!availability.data) {
      this.loadError.set(
        toErrorMessage(availability.error, 'Could not load seats for this trip. Try again.')
      );
      return;
    }
    this.bookability.set(availability.data);

    if (!fare.data) {
      // Not a load failure — the seats are real, there is just no fare
      // configured for this segment, which blocks booking rather than
      // blocking display.
      this.farePerSeat.set(null);
      this.fareError.set(
        toErrorMessage(
          fare.error,
          'No fare is configured for this journey yet, so it cannot be booked.'
        )
      );
      return;
    }
    this.farePerSeat.set(fare.data.amount);
    this.currency.set(fare.data.currency);
  }

  protected isSelected(seatId: string): boolean {
    return this.selectedSeatIds().has(seatId);
  }

  protected toggleSeat(entry: SeatAvailability): void {
    if (!entry.is_available || this.farePerSeat() === null) {
      return;
    }
    this.selectedSeatIds.update((current) => {
      const next = new Set(current);
      if (!next.delete(entry.seat.id)) {
        next.add(entry.seat.id);
      }
      return next;
    });
  }

  protected seatLabel(entry: SeatAvailability): string {
    return entry.is_available
      ? `Seat ${entry.seat.seat_number}`
      : `Seat ${entry.seat.seat_number}, unavailable`;
  }

  protected async back(): Promise<void> {
    await this.router.navigate(['/search']);
  }

  protected setPassengerCount(value: string): void {
    this.passengerCount.set(Number(value));
  }

  protected async continueToConfirm(): Promise<void> {
    const carried = this.request();
    const fare = this.farePerSeat();
    if (!carried || fare === null || this.selectedCount() === 0) {
      return;
    }
    const money = { farePerSeat: fare, currency: this.currency() };
    const selected = this.selectedSeatIds();
    // Overwrites whatever the search screen carried in: the envelope is
    // the fresher of the two, and the confirm screen is the last thing
    // the passenger reads before committing.
    const request = { ...carried, tripClass: this.bookability()?.trip_class ?? carried.tripClass };
    const state: BookingRequest = this.buysPlaces()
      ? { ...request, ...money, kind: 'places', passengerCount: this.passengerCount() }
      : {
          ...request,
          ...money,
          kind: 'seats',
          seats: this.availability()
            .filter((entry) => selected.has(entry.seat.id))
            .map((entry) => ({ id: entry.seat.id, seatNumber: entry.seat.seat_number })),
        };
    await this.router.navigate(['/book'], { state });
  }
}
