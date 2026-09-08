import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  Alert,
  Button,
  Checkbox,
  FormSection,
  PageHeader,
  Select,
  Skeleton,
  StatusPill,
  TextField,
  formatMoney,
  plural,
} from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { CounterBookingStore } from '../../shared/data/store/counter-booking.store';
import type {
  CounterBookingRequest,
  Passenger,
  SeatAvailability,
} from '../../shared/data/store/counter-booking.store';
import { RouteStore, type Route } from '../../shared/data/store/route.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { TripStore } from '../../shared/data/store/trip.store';
import { applyServerErrors, clearServerErrors, fieldErrorMessage } from '../../shared/form-errors';

/** The most places one counter booking may buy when capacity is not
 * enforced. The same cap `customer-app`'s seat picker uses, for the same
 * reason: a bound has to come from somewhere, and a group larger than
 * this is a conversation, not a form field. */
const UNLIMITED_PLACES_CAP = 10;

/** Today, as the `<input type="date">` value the trip filter wants. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
}

/**
 * Booking for a passenger who is standing at the counter —
 * docs/specs/18-manifest-and-staff-booking.md slice 2.
 *
 * ## Four steps, in the order the conversation happens
 *
 * Who → which trip → which seats → confirm. The passenger is resolved
 * first because everything after it is wasted work if they have no
 * account: `POST /bookings/staff/` books for an **existing** passenger
 * only, and creating an account on someone's behalf needs consent, a
 * credential to deliver and a claim flow — its own spec, not a field on
 * this form.
 *
 * ## The trip picker filters by date; it does not trust one page
 *
 * `booking-list`'s trip dropdown fetches `limit=100` against
 * `Trip.Meta.ordering`, which is ascending — so a busy Business is
 * offered its oldest hundred trips and cannot reach today's at all.
 * That is a recorded defect, and repeating it on a screen whose whole
 * job is *today's* departures would be worse. This asks the server for
 * one service date at a time.
 *
 * ## No cash
 *
 * ADR-0006's chart of accounts has no cash account, so the only money
 * this screen can move is the passenger's own wallet balance. Anything
 * else leaves the booking `pending_payment` with the seats held, which
 * is stated on the screen rather than left to be discovered.
 */
@Component({
  selector: 'app-counter-booking',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    Alert,
    Button,
    Checkbox,
    FormSection,
    PageHeader,
    Select,
    Skeleton,
    StatusPill,
    TextField,
  ],
  templateUrl: './counter-booking.html',
})
export class CounterBooking {
  private readonly fb = inject(FormBuilder);
  protected readonly store = inject(CounterBookingStore);
  protected readonly trips = inject(TripStore);
  protected readonly routes = inject(RouteStore);
  protected readonly selectedBusiness = inject(SelectedBusinessStore);

  protected readonly formatMoney = formatMoney;
  protected readonly plural = plural;

  protected readonly lookupForm = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected readonly form = this.fb.nonNullable.group({
    service_date: [today(), Validators.required],
    trip: ['', Validators.required],
    from_stop: ['', Validators.required],
    to_stop: ['', Validators.required],
    passenger_count: [1, [Validators.required, Validators.min(1)]],
    pay_from_wallet: [false],
  });

  protected readonly errorMessage = signal<string | null>(null);
  protected readonly selectedSeats = signal<readonly string[]>([]);

  /**
   * One key per assembled booking, **not** per submit.
   *
   * Regenerating it on retry is how a timeout that actually reached the
   * server becomes two bookings and two held seats. It is replaced only
   * once a booking succeeds and the form is cleared for the next
   * passenger.
   */
  private idempotencyKey = crypto.randomUUID();

  // `toSignal`, not `computed` over `.value`: a computed over a plain
  // form-control value depends on no signal and caches its first result
  // forever — the recorded trap.
  private readonly tripId = toSignal(this.form.controls.trip.valueChanges, {
    initialValue: this.form.controls.trip.value,
  });
  private readonly serviceDate = toSignal(this.form.controls.service_date.valueChanges, {
    initialValue: this.form.controls.service_date.value,
  });
  private readonly fromStopId = toSignal(this.form.controls.from_stop.valueChanges, {
    initialValue: this.form.controls.from_stop.value,
  });
  private readonly toStopId = toSignal(this.form.controls.to_stop.valueChanges, {
    initialValue: this.form.controls.to_stop.value,
  });

  protected readonly selectedTrip = computed(() =>
    this.trips.items().find((trip) => trip.id === this.tripId())
  );

  protected readonly tripOptions = computed<SelectOption[]>(() => [
    { value: '', label: this.trips.items().length ? 'Choose a departure' : 'No departures found' },
    ...this.trips.items().map((trip) => ({
      value: trip.id,
      label: `${trip.route.name} — ${new Date(trip.scheduled_departure_at).toLocaleTimeString(
        undefined,
        { hour: '2-digit', minute: '2-digit' }
      )}`,
    })),
  ]);

  /**
   * The chosen trip's own route, resolved by id.
   *
   * **`findById`, never `routes.items().find(...)`.** A bounded page
   * plus `.find()` is the recorded defect this repo has been bitten by
   * more than once: a Business with more than one page of routes simply
   * would not find its own, and the stop pickers would sit empty with
   * nothing on screen saying why. It failed this screen's first e2e run
   * for exactly that reason.
   */
  protected readonly selectedRoute = signal<Route | null>(null);

  /** The route's stops, in route order. A stop that is not on the route
   * is refused by the server, so offering one would be offering a
   * certain failure. */
  protected readonly stopOptions = computed<SelectOption[]>(() => {
    const stops = [...(this.selectedRoute()?.stops ?? [])].sort((a, b) => a.sequence - b.sequence);
    return [
      { value: '', label: stops.length ? 'Choose a stop' : 'Pick a departure first' },
      ...stops.map((stop) => ({ value: stop.id, label: stop.name })),
    ];
  });

  /** A trip that assigns seats *and* lets the passenger choose one. Open
   * seating and "quick book" both sell places rather than seats, and
   * send `passenger_count` instead. */
  protected readonly picksSeats = computed(
    () => this.store.bookability()?.seat_selection_enabled === true
  );

  /**
   * A bounded list, never a free number field.
   *
   * Same cap and same reasoning as `customer-app`'s seat picker: an
   * unbounded number input is an invitation to a typo that books forty
   * seats, and a counter agent is typing fast with someone waiting.
   * Where capacity *is* known, that is the ceiling — offering a place
   * the server will refuse is offering a certain failure.
   */
  protected readonly placeOptions = computed<SelectOption[]>(() => {
    const remaining = this.store.bookability()?.capacity_remaining;
    const cap = Math.max(Math.min(remaining ?? UNLIMITED_PLACES_CAP, UNLIMITED_PLACES_CAP), 1);
    return Array.from({ length: cap }, (_, index) => ({
      value: String(index + 1),
      label: String(index + 1),
    }));
  });

  protected readonly capacityLabel = computed(() => {
    const remaining = this.store.bookability()?.capacity_remaining;
    // `null` is "not capped", which is a different fact from "none
    // left" — a 0 here would stop an agent selling a seat that exists.
    return remaining === null || remaining === undefined ? 'Not capped' : String(remaining);
  });

  constructor() {
    // **`untracked` around every store call, in all three effects.**
    // Without it, the signal reads that happen *inside* a store method
    // become dependencies of the effect that called it, so the store's
    // own write re-invalidates that effect and it calls the store
    // again — an infinite synchronous loop that blocks the browser's
    // main thread rather than erroring. It cost an e2e debugging
    // session here; it is the pattern `trip-list` already uses for
    // exactly this reason.

    // Trips for one Business and one service date. Refetched on either
    // change rather than filtered client-side, so a busy operator's
    // list stays bounded by the server.
    effect(
      () => {
        const business = this.selectedBusiness.selectedBusinessId();
        const serviceDate = this.serviceDate();
        if (!business || !serviceDate) {
          return;
        }
        untracked(() => {
          void this.trips.updateQuery({ business, service_date: serviceDate, status: 'scheduled' });
        });
      },
      { allowSignalWrites: true }
    );

    // The chosen trip's route, fetched by id rather than looked for in
    // a page of routes that may not contain it.
    effect(
      () => {
        const trip = this.selectedTrip();
        untracked(() => {
          if (!trip) {
            this.selectedRoute.set(null);
            return;
          }
          if (this.selectedRoute()?.id === trip.route.id) {
            return;
          }
          this.selectedRoute.set(null);
          void this.routes.findById(trip.route.id).then((route) => {
            // Guard against a slower answer for a trip the agent has
            // already moved on from — the same monotonic-staleness
            // problem a refetching list store has.
            if (this.selectedTrip()?.route.id === route?.id) {
              this.selectedRoute.set(route);
            }
          });
        });
      },
      { allowSignalWrites: true }
    );

    // Availability depends on the whole segment, not just the trip: a
    // fare and a seat's freedom are both per-segment.
    effect(
      () => {
        const trip = this.tripId();
        const from = this.fromStopId();
        const to = this.toStopId();
        untracked(() => {
          if (!trip || !from || !to || from === to) {
            this.store.clearBookability();
            return;
          }
          this.selectedSeats.set([]);
          void this.store.loadBookability(trip, from, to);
        });
      },
      { allowSignalWrites: true }
    );

    // Narrowing a list does not move a chosen value into it: a seat
    // selected on one segment may not be free on another, so the
    // selection is reconciled against what came back rather than left
    // to submit and be refused.
    effect(
      () => {
        const free = new Set(this.store.availableSeats().map((entry) => entry.seat.id));
        untracked(() => {
          const kept = this.selectedSeats().filter((id) => free.has(id));
          if (kept.length !== this.selectedSeats().length) {
            this.selectedSeats.set(kept);
          }
        });
      },
      { allowSignalWrites: true }
    );
  }

  protected async onLookup(): Promise<void> {
    if (this.lookupForm.invalid) {
      this.lookupForm.markAllAsTouched();
      return;
    }
    await this.store.lookup(this.lookupForm.getRawValue().email);
  }

  protected onChangePassenger(): void {
    this.store.clearPassenger();
    this.lookupForm.reset({ email: '' });
  }

  protected toggleSeat(seatId: string): void {
    const current = this.selectedSeats();
    this.selectedSeats.set(
      current.includes(seatId) ? current.filter((id) => id !== seatId) : [...current, seatId]
    );
  }

  protected isSelected(seatId: string): boolean {
    return this.selectedSeats().includes(seatId);
  }

  protected seatLabel(entry: SeatAvailability): string {
    return entry.seat.seat_number;
  }

  /**
   * The passenger's name, or a statement that there isn't one.
   *
   * The seeded accounts carry no name at all, which rendered as an
   * empty line above the address and looked like a failed lookup. The
   * backend cannot fall back to the email local part the way the
   * manifest's `_passenger_name` does — the local part is exactly what
   * masking hides — so the honest fallback is to say the account has no
   * name and let the masked address identify them.
   */
  protected passengerName(passenger: Passenger): string {
    const name = `${passenger.first_name} ${passenger.last_name}`.trim();
    return name || 'No name on this account';
  }

  protected lookupFieldError(): string | null {
    return fieldErrorMessage(this.lookupForm.controls.email, {
      label: 'Email',
      messages: { email: 'Enter a complete email address.' },
    });
  }

  protected fieldError(name: keyof typeof this.form.controls): string | null {
    return fieldErrorMessage(this.form.get(name as string));
  }

  protected seatsError(): string | null {
    // Rendered like any other field error rather than only disabling
    // the button: a disabled button with no explanation is the same
    // dead end as a silent rejection.
    return this.picksSeats() && this.submitted() && this.selectedSeats().length === 0
      ? 'Choose at least one seat.'
      : null;
  }

  private readonly submitted = signal(false);

  protected async onSubmit(): Promise<void> {
    this.submitted.set(true);
    const passenger = this.store.passenger();
    if (!passenger) {
      this.errorMessage.set('Find the passenger before booking.');
      return;
    }
    if (this.form.invalid || this.seatsError()) {
      this.form.markAllAsTouched();
      return;
    }

    this.errorMessage.set(null);
    clearServerErrors(this.form);
    const value = this.form.getRawValue();
    const request: CounterBookingRequest = this.picksSeats()
      ? {
          trip: value.trip,
          passenger: passenger.id,
          seats: this.selectedSeats().map((seat) => ({
            seat,
            from_stop: value.from_stop,
            to_stop: value.to_stop,
          })),
          pay_from_wallet: value.pay_from_wallet,
        }
      : {
          trip: value.trip,
          passenger: passenger.id,
          passenger_count: value.passenger_count,
          from_stop: value.from_stop,
          to_stop: value.to_stop,
          pay_from_wallet: value.pay_from_wallet,
        };

    const { ok, error } = await this.store.book(request, this.idempotencyKey);
    if (!ok) {
      this.errorMessage.set(
        applyServerErrors(this.form, error, 'Could not create this booking.', {
          // `seats` and `passenger` carry values that no control on this
          // form renders — the seat chips are not a form control, and
          // the passenger came from the lookup above — so their errors
          // have to reach the page-level alert or vanish.
          unplaceable: ['seats', 'passenger', 'business'],
        })
      );
      return;
    }
    // Only now: the key has bought a booking, so the next one needs a
    // new one.
    this.idempotencyKey = crypto.randomUUID();
    this.submitted.set(false);
  }

  /** Book again for the same passenger — the second leg of a return, or
   * a colleague travelling with them. */
  protected onBookAnother(): void {
    this.store.resetBooking();
    this.selectedSeats.set([]);
    this.submitted.set(false);
    this.form.patchValue({ trip: '', from_stop: '', to_stop: '', pay_from_wallet: false });
  }
}
