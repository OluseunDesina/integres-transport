import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { FormsModule } from '@angular/forms';
import { AuthStore } from '@auth';
import { Alert, Button, EmptyState, PageHeader, Select, Skeleton, TextField, plural } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { BookingSteps } from '../shared/booking-steps';
import type { BookingRequest, SeatPickerRequest, TravelerDetail } from '../shared/booking-draft';
import { readSeatPickerRequest } from '../shared/booking-draft';
import { formatMoney, multiplyDecimal } from '../shared/money';
import { tripClassLabel } from '../shared/trip-class';

const EMPTY_TRAVELER: TravelerDetail = {
  title: '',
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
  dateOfBirth: '',
  gender: '',
  nationality: '',
};

/** First/last name, phone and email are the fields a booking cannot do
 * anything useful without; title/DOB/gender/nationality are collected
 * but not required to proceed — docs/specs/22-marketplace.md's own
 * "basic things" framing, not every field on the model. */
function travelerIsComplete(traveler: TravelerDetail): boolean {
  return (
    traveler.firstName.trim() !== '' &&
    traveler.lastName.trim() !== '' &&
    traveler.phone.trim() !== '' &&
    traveler.email.trim() !== ''
  );
}

const TITLE_OPTIONS: SelectOption[] = [
  { value: '', label: 'Select…' },
  { value: 'mr', label: 'Mr' },
  { value: 'mrs', label: 'Mrs' },
  { value: 'miss', label: 'Miss' },
  { value: 'ms', label: 'Ms' },
  { value: 'dr', label: 'Dr' },
];

// Collapses the model's blank-vs-"prefer_not_to_say" distinction
// (apps.booking.models.Traveler.Gender) into one UI choice — a
// passenger who leaves this unset and one who actively picks "prefer
// not to say" are the same thing from this screen's point of view.
const GENDER_OPTIONS: SelectOption[] = [
  { value: '', label: 'Prefer not to say' },
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' },
];

type Bookability = components['schemas']['TripBookability'];

/** The most places one booking may buy when capacity is unlimited
 * (`capacity_enforced` off, so `capacity_remaining` is null). A cap has
 * to come from somewhere, and an unbounded number input on a phone is
 * an invitation to a typo that books forty seats. Operators who need
 * more than this take group bookings off-app. */
const UNLIMITED_PLACES_CAP = 10;

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
 * "How many passengers, and who" — docs/specs/22-marketplace.md slice 3.
 * Every booking mode goes through this one screen the same way: no seat
 * map, no per-seat picking. `apps.booking.services.create_booking`
 * auto-allocates whichever real seats a reservation-mode trip needs
 * (server-side, at the point `booking-confirm` submits), and a passenger
 * who wants a *specific* seat instead gets that from `booking-confirm`'s
 * own "Change seat" link, once the booking — and the hold — already
 * exist. Before slice 3 this screen carried a full seat grid (picked
 * seats, per-seat traveler forms); that grid and every reason for it are
 * gone along with the manual-pick step, not just hidden.
 *
 * Availability is always fetched here, never carried forward from the
 * search screen — it is the most volatile thing in the flow, and a
 * segment-aware availability query (`?from_stop=&to_stop=`) is the only
 * thing that knows how many places are actually left on *this* leg
 * range.
 *
 * Three states are load-bearing rather than incidental:
 * - `not_configured` — nobody has assigned a vehicle yet. An operator
 *   fixes this; the passenger cannot.
 * - `sold_out` — genuinely full for this segment. Told apart from
 *   `not_configured` by the availability envelope itself, never guessed
 *   from an empty/zero count.
 * - an unpriced segment 404s on the fare endpoint — shown as a blocking
 *   alert *before* anything is selectable, so a passenger never fills in
 *   traveler details for a trip that cannot be priced.
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
    TextField,
  ],
  templateUrl: './seat-picker.html',
})
export class SeatPicker implements OnInit {
  private readonly api = inject(API_CLIENT);
  private readonly router = inject(Router);
  private readonly authStore = inject(AuthStore);

  protected readonly request = signal<SeatPickerRequest | null>(readSeatPickerRequest(this.router));

  protected readonly loading = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly fareError = signal<string | null>(null);

  private readonly bookability = signal<Bookability | null>(null);
  private readonly farePerSeat = signal<string | null>(null);
  protected readonly currency = signal('');

  protected readonly passengerCount = signal(1);

  /** One entry per passenger, index-aligned with `passengerCount` — see
   * `travelerFor`/`setTravelerField`. Resized (not rebuilt) whenever the
   * count changes, so a passenger who bumps the count up and back down
   * does not lose what they already typed for the others. */
  protected readonly travelers = signal<TravelerDetail[]>([{ ...EMPTY_TRAVELER }]);
  protected readonly titleOptions = TITLE_OPTIONS;
  protected readonly genderOptions = GENDER_OPTIONS;

  protected readonly status = computed(() => this.bookability()?.status ?? null);
  protected readonly notConfigured = computed(() => this.status() === 'not_configured');
  protected readonly soldOut = computed(() => this.status() === 'sold_out');

  /** Why a specific seat is never asked for on this screen — not the
   * same sentence for every booking mode. Open seating assigns nobody a
   * seat at all; a reservation-mode trip always gets one auto-assigned,
   * whether or not the operator would otherwise let a passenger choose —
   * only the second sentence's own trips get a "Change seat" link
   * afterward, per `bookability.seat_selection_enabled`. */
  protected readonly placesHint = computed(() => {
    const bookability = this.bookability();
    if (bookability?.booking_mode === 'open_seating') {
      return "Seats aren't assigned on this service — sit anywhere that's free.";
    }
    return bookability?.seat_selection_enabled
      ? "We'll assign your seats — you can change them after booking."
      : 'This operator assigns seats for you — you just tell us how many.';
  });

  /** Asking "How many passengers?" above "Not open for booking yet"
   * reads as a broken screen — the question is only worth asking when
   * there is something to answer it about. */
  protected readonly heading = computed(() =>
    this.status() === 'open' ? 'How many passengers?' : 'Your journey'
  );

  /** Options for the "how many" control, capped by what is actually
   * left. Constrained rather than free text, matching this workspace's
   * standing preference for inputs that cannot express a wrong value. */
  protected readonly placeOptions = computed<number[]>(() => {
    const remaining = this.bookability()?.capacity_remaining;
    const cap = remaining ?? UNLIMITED_PLACES_CAP;
    return Array.from({ length: Math.max(Math.min(cap, UNLIMITED_PLACES_CAP), 1) }, (_, i) => i + 1);
  });

  /** `placeOptions` in the shape `ui-select` takes. The numbers stay the
   * source of truth — the cap arithmetic above is the part worth
   * testing, and it should not have to know about a UI type. */
  protected readonly placeSelectOptions = computed<SelectOption[]>(() =>
    this.placeOptions().map((count) => ({ value: String(count), label: String(count) }))
  );

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

  protected readonly selectionLabel = computed(() => plural(this.passengerCount(), 'passenger'));

  protected readonly totalLabel = computed(() => {
    const fare = this.farePerSeat();
    if (fare === null) {
      return null;
    }
    return formatMoney(multiplyDecimal(fare, this.passengerCount()), this.currency());
  });

  protected readonly fareLabel = computed(() => {
    const fare = this.farePerSeat();
    return fare === null ? null : formatMoney(fare, this.currency());
  });

  protected readonly canContinue = computed(() => {
    if (this.passengerCount() === 0 || this.farePerSeat() === null) {
      return false;
    }
    return this.travelers().slice(0, this.passengerCount()).every(travelerIsComplete);
  });

  async ngOnInit(): Promise<void> {
    // A passenger who deep-links or refreshes into a lost navigation
    // state has no segment to price — start the flow over rather than
    // render a half-populated screen.
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
    this.passengerCount.set(1);
    this.travelers.set([{ ...EMPTY_TRAVELER }]);

    const path = { path: { id: request.tripId } };
    const query = { from_stop: request.fromStop.id, to_stop: request.toStop.id };

    const [availability, fare] = await Promise.all([
      this.api.GET('/api/v1/marketplace/trips/{id}/availability/', { params: { ...path, query } }),
      this.api.GET('/api/v1/marketplace/trips/{id}/fare/', { params: { ...path, query } }),
    ]);

    this.loading.set(false);

    if (!availability.data) {
      this.loadError.set(
        toErrorMessage(availability.error, 'Could not load this trip. Try again.')
      );
      return;
    }
    this.bookability.set(availability.data);

    if (!fare.data) {
      // Not a load failure — the trip is real, there is just no fare
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

  /** Current value of one passenger's form. Never absent from the
   * caller's point of view: an unfilled field is `EMPTY_TRAVELER`'s
   * `''`, not `undefined`. */
  protected travelerFor(index: number): TravelerDetail {
    return this.travelers()[index] ?? EMPTY_TRAVELER;
  }

  protected setTravelerField(index: number, field: keyof TravelerDetail, value: string): void {
    this.travelers.update((current) => {
      const next = [...current];
      next[index] = { ...(next[index] ?? EMPTY_TRAVELER), [field]: value };
      return next;
    });
  }

  protected async back(): Promise<void> {
    await this.router.navigate(['/search']);
  }

  /** Grows or shrinks `travelers` to match — growing appends blank
   * forms, shrinking drops from the end, so a passenger who dials the
   * count down and back up sees their earlier entries again rather than
   * blank ones. */
  protected setPassengerCount(value: string): void {
    const count = Number(value);
    this.passengerCount.set(count);
    this.travelers.update((current) => {
      if (current.length >= count) {
        return current;
      }
      return [...current, ...Array.from({ length: count - current.length }, () => ({ ...EMPTY_TRAVELER }))];
    });
  }

  protected async continueToConfirm(): Promise<void> {
    const carried = this.request();
    const fare = this.farePerSeat();
    const bookability = this.bookability();
    if (!carried || fare === null || !bookability || !this.canContinue()) {
      return;
    }
    // Overwrites whatever the search screen carried in: the envelope is
    // the fresher of the two, and the confirm screen is the last thing
    // the passenger reads before committing.
    const state: BookingRequest = {
      ...carried,
      tripClass: bookability.trip_class ?? carried.tripClass,
      farePerSeat: fare,
      currency: this.currency(),
      passengerCount: this.passengerCount(),
      travelers: this.travelers().slice(0, this.passengerCount()),
      seatSelectionEnabled: bookability.seat_selection_enabled,
    };
    // The one point a guest is asked to log in — see this app's own
    // `app.routes.ts` and `booking-draft.ts`'s `readPendingBooking()`
    // for the rest of the handoff. Carrying `state` as `pendingBooking`
    // rather than navigating straight to `/login` with nothing keeps
    // this selection alive across the round trip; an already-signed-in
    // passenger's flow is unchanged.
    if (!this.authStore.isAuthenticated()) {
      await this.router.navigate(['/login'], { state: { pendingBooking: state } });
      return;
    }
    await this.router.navigate(['/book'], { state });
  }
}
