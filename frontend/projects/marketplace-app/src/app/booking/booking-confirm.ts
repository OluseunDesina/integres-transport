import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { Alert, Button, Countdown, PageHeader, Skeleton } from '@shared-ui';

type TravelerInput = components['schemas']['TravelerInput'];
type TravelerOutput = components['schemas']['TravelerOutput'];
type SeatAvailability = components['schemas']['SeatAvailability'];

import { BookingSteps } from '../shared/booking-steps';
import type { BookingRequest, SeatPickerRequest, TravelerDetail } from '../shared/booking-draft';
import { readBookingRequest } from '../shared/booking-draft';
import { BookingStore, type Booking } from '../shared/data/store/booking.store';
import { formatMoney, multiplyDecimal } from '../shared/money';
import { tripClassLabel } from '../shared/trip-class';

const TRIP_FULL_NOTICE =
  'This departure filled up while you were entering traveler details. Try again.';

/** camelCase → the API's snake_case `TravelerInputSerializer` shape,
 * omitting title/date_of_birth/gender/nationality entirely when blank
 * rather than sending `''` — `title`/`gender` are `ChoiceField`s on the
 * backend, which reject an empty string as an invalid choice; leaving
 * the key out entirely is what "not answered" actually means to
 * `required=False`. */
function toTravelerBody(traveler: TravelerDetail): TravelerInput {
  const body: TravelerInput = {
    first_name: traveler.firstName,
    last_name: traveler.lastName,
    phone: traveler.phone,
    email: traveler.email,
  };
  if (traveler.title) {
    body.title = traveler.title as TravelerInput['title'];
  }
  if (traveler.dateOfBirth) {
    body.date_of_birth = traveler.dateOfBirth;
  }
  if (traveler.gender) {
    body.gender = traveler.gender as TravelerInput['gender'];
  }
  if (traveler.nationality) {
    body.nationality = traveler.nationality;
  }
  return body;
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
    for (const value of Object.values(error as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0];
      }
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return fallback;
}

/**
 * Final review and submit —
 * docs/specs/4-fares-seating-booking-frontend.md §4.3, reworked by
 * docs/specs/22-marketplace.md slice 3. Creates the Booking and stops: a
 * Booking reaches `pending_payment` and no further, since Phase 5 owns
 * payment. There is deliberately no "pay now" affordance anywhere on
 * this screen (§1) — that stays on `my-bookings`, which is also where
 * this screen sends the passenger on to.
 *
 * The `Idempotency-Key` is generated once per visit rather than per
 * click, which is what makes the submit button safe to press again
 * after a timeout: the backend returns the *original* Booking for a
 * repeat of the same key and body instead of double-booking. A genuine
 * "this departure just filled up" 409 is the opposite case and must not
 * be retried blindly — it sends the passenger back to the passenger-
 * count screen, since the fresh availability check happens there.
 *
 * **docs/specs/21-passenger-experience.md slice 2.** Submitting does not
 * navigate away immediately — `createdBooking` holds the response and
 * the template swaps the submit form for a held/confirmed panel with a
 * `ui-countdown`, fed from the same response's `hold_expires_in_seconds`
 * with no second request. "Continue to My Bookings" is the passenger's
 * own action rather than an automatic redirect, so they see what they
 * just bought before leaving.
 *
 * **docs/specs/22-marketplace.md slice 3.** The request no longer names
 * seats at all — `seat-picker` collects a passenger count and one
 * traveler per passenger, and `create_booking` auto-allocates whichever
 * real seats a reservation-mode trip needs. This screen is where the
 * result of that allocation is actually shown: each assigned seat,
 * alongside its traveler's name, with a "Change seat" link when
 * `request().seatSelectionEnabled` says the operator allows it — a
 * quick-book trip (the operator's own choice to disallow passenger seat
 * choice) never shows the link at all, matching the same policy
 * `apps.booking.serializers.BookingChangeSeatSerializer` enforces
 * server-side.
 */
@Component({
  selector: 'app-booking-confirm',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, BookingSteps, Alert, Button, Countdown, PageHeader, Skeleton],
  templateUrl: './booking-confirm.html',
})
export class BookingConfirm implements OnInit {
  private readonly api = inject(API_CLIENT);
  private readonly router = inject(Router);
  private readonly bookingStore = inject(BookingStore);

  protected readonly request = signal<BookingRequest | null>(readBookingRequest(this.router));

  private readonly idempotencyKey = crypto.randomUUID();

  protected readonly submitting = signal(false);
  protected readonly submitError = signal<string | null>(null);

  /** Set on a successful submit; from then on the template shows the
   * held/confirmed panel instead of the review form. */
  protected readonly createdBooking = signal<Booking | null>(null);

  /** Which reservation's "Change seat" picker is open, if any — null
   * closes it. Only one at a time: a passenger changing seat 2 has no
   * reason to also be mid-change on seat 1. */
  protected readonly changingSeatFor = signal<string | null>(null);
  protected readonly changeSeatOptions = signal<SeatAvailability[] | null>(null);
  protected readonly changeSeatLoading = signal(false);
  protected readonly changeSeatError = signal<string | null>(null);

  protected readonly travelerNames = computed(() => {
    const request = this.request();
    if (!request) {
      return '';
    }
    return request.travelers
      .map((traveler) => `${traveler.firstName} ${traveler.lastName}`.trim())
      .filter((name) => name !== '')
      .join(', ');
  });

  protected readonly totalLabel = computed(() => {
    const request = this.request();
    if (!request) {
      return '';
    }
    return formatMoney(
      multiplyDecimal(request.farePerSeat, request.passengerCount),
      request.currency
    );
  });

  protected readonly fareLabel = computed(() => {
    const request = this.request();
    return request ? formatMoney(request.farePerSeat, request.currency) : '';
  });

  /** Blank rather than a placeholder when the flow carried no class —
   * a state object written by an older build (see `booking-draft.ts`).
   * The row is omitted entirely in that case, the same way `Seats` is
   * on a service that does not assign them. */
  protected readonly serviceClass = computed(() => tripClassLabel(this.request()?.tripClass));

  /** Whether "Change seat" should appear at all on the held panel —
   * never on open seating (nothing to change) and never on a true
   * quick-book trip (the operator's own choice), regardless of what the
   * created Booking's own `seats` list happens to contain. */
  protected readonly canChangeSeat = computed(() => this.request()?.seatSelectionEnabled === true);

  async ngOnInit(): Promise<void> {
    if (!this.request()) {
      await this.router.navigate(['/search']);
    }
  }

  protected async submit(): Promise<void> {
    const request = this.request();
    if (!request || this.submitting()) {
      return;
    }
    this.submitting.set(true);
    this.submitError.set(null);

    const { data, error, response } = await this.api.POST('/api/v1/marketplace/bookings/', {
      // Idempotency-Key is a declared header *parameter* on this
      // operation, so it travels in params.header — unlike
      // Authorization, which `@auth`'s middleware attaches centrally
      // (docs/specs/13-session-resilience.md).
      params: { header: { 'Idempotency-Key': this.idempotencyKey } },
      // One shape, for every booking mode — docs/specs/22-marketplace.md
      // slice 3. The backend auto-allocates a seat per traveler for a
      // reservation-mode trip; an open-seating trip just holds no seats
      // at all. Neither case names one here.
      body: {
        trip: request.tripId,
        passenger_count: request.passengerCount,
        from_stop: request.fromStop.id,
        to_stop: request.toStop.id,
        travelers: request.travelers.map(toTravelerBody),
      },
    });

    this.submitting.set(false);

    if (data) {
      this.createdBooking.set(data);
      return;
    }

    if (response?.status === 409) {
      await this.returnToSeatPicker(request, TRIP_FULL_NOTICE);
      return;
    }

    this.submitError.set(toErrorMessage(error, 'Could not complete your booking. Try again.'));
  }

  protected async backToSeats(): Promise<void> {
    const request = this.request();
    if (request) {
      await this.returnToSeatPicker(request);
    }
  }

  protected async continueToMyBookings(): Promise<void> {
    await this.router.navigate(['/my-bookings']);
  }

  /** `ui-countdown` reaching zero is not the same fact as the hold
   * actually being gone — the sweep task runs once a minute, so this
   * re-fetches through `BookingStore.findById` (the same "handed an id,
   * need the real thing" lookup `report-issue` already uses) and shows
   * whatever the server now says, rather than declaring the seats lost
   * on a local timer alone. */
  protected async onHoldExpired(): Promise<void> {
    const booking = this.createdBooking();
    if (!booking) {
      return;
    }
    const fresh = await this.bookingStore.findById(booking.id);
    if (fresh) {
      this.createdBooking.set(fresh);
    }
  }

  /** Opens the "Change seat" picker for one reservation — fetches the
   * trip's current availability fresh (never carried forward: it is the
   * most volatile thing in this flow, same reasoning `seat-picker`'s own
   * `load()` already documents), and excludes the reservation's current
   * seat since it is already this passenger's own. */
  protected async openChangeSeat(reservationId: string, currentSeatNumber: string): Promise<void> {
    const request = this.request();
    if (!request) {
      return;
    }
    this.changingSeatFor.set(reservationId);
    this.changeSeatError.set(null);
    this.changeSeatOptions.set(null);
    this.changeSeatLoading.set(true);

    const { data, error } = await this.api.GET('/api/v1/marketplace/trips/{id}/availability/', {
      params: {
        path: { id: request.tripId },
        query: { from_stop: request.fromStop.id, to_stop: request.toStop.id },
      },
    });

    this.changeSeatLoading.set(false);

    if (!data) {
      this.changeSeatError.set(toErrorMessage(error, 'Could not load available seats.'));
      return;
    }
    this.changeSeatOptions.set(
      data.seats.filter(
        (entry) => entry.is_available && entry.seat.seat_number !== currentSeatNumber
      )
    );
  }

  /** "Ada Lovelace, Grace Hopper" — a plain method rather than a
   * template expression, since Angular's template parser has no arrow
   * functions and `booking.travelers` is only known once `createdBooking`
   * is set, not something a `computed()` can read ahead of time. */
  protected travelerListLabel(travelers: TravelerOutput[]): string {
    return travelers.map((traveler) => `${traveler.first_name} ${traveler.last_name}`).join(', ');
  }

  protected cancelChangeSeat(): void {
    this.changingSeatFor.set(null);
    this.changeSeatOptions.set(null);
    this.changeSeatError.set(null);
  }

  protected async chooseNewSeat(reservationId: string, seatId: string): Promise<void> {
    const booking = this.createdBooking();
    if (!booking) {
      return;
    }
    this.changeSeatLoading.set(true);
    this.changeSeatError.set(null);

    const { data, error } = await this.api.POST(
      '/api/v1/marketplace/bookings/{id}/reservations/{reservation_pk}/change-seat/',
      {
        params: { path: { id: booking.id, reservation_pk: reservationId } },
        body: { seat: seatId },
      }
    );

    this.changeSeatLoading.set(false);

    if (data) {
      this.createdBooking.set(data);
      this.cancelChangeSeat();
      return;
    }
    this.changeSeatError.set(toErrorMessage(error, 'Could not change seat. Try again.'));
  }

  /** `notice` is deliberately not defaulted: plain "Back" must not
   * carry a conflict message, and an omitted argument is easy to read
   * as "no notice" at each call site. */
  private async returnToSeatPicker(request: BookingRequest, notice?: string): Promise<void> {
    const state: SeatPickerRequest = {
      tripId: request.tripId,
      routeName: request.routeName,
      serviceDate: request.serviceDate,
      scheduledDepartureAt: request.scheduledDepartureAt,
      fromStop: request.fromStop,
      toStop: request.toStop,
      // Rebuilt field by field rather than spread, so a new field on
      // SeatPickerRequest has to be added here too or it is silently
      // dropped on the way back.
      tripClass: request.tripClass,
      notice,
    };
    await this.router.navigate(['/search/seats'], { state });
  }
}
