import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { Alert, Button, Countdown, PageHeader } from '@shared-ui';

type TravelerInput = components['schemas']['TravelerInput'];

import { BookingSteps } from '../shared/booking-steps';
import type { BookingRequest, SeatPickerRequest, TravelerDetail } from '../shared/booking-draft';
import { readBookingRequest } from '../shared/booking-draft';
import { BookingStore, type Booking } from '../shared/data/store/booking.store';
import { formatMoney, multiplyDecimal } from '../shared/money';
import { tripClassLabel } from '../shared/trip-class';

const SEAT_CONFLICT_NOTICE =
  'One of the seats you picked was taken while you were booking. Choose another.';

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
 * docs/specs/4-fares-seating-booking-frontend.md §4.3. Creates the
 * Booking and stops: a Booking reaches `pending_payment` and no
 * further, since Phase 5 owns payment. There is deliberately no "pay
 * now" affordance anywhere on this screen (§1) — that stays on
 * `my-bookings`, which is also where this screen sends the passenger
 * on to.
 *
 * The `Idempotency-Key` is generated once per visit rather than per
 * click, which is what makes the submit button safe to press again
 * after a timeout: the backend returns the *original* Booking for a
 * repeat of the same key and body instead of double-booking the seats
 * (§6). A genuine seat conflict is the opposite case and must not be
 * retried blindly — it sends the passenger back to the seat map, since
 * a stale selection needs a fresh availability check, not a resubmit.
 *
 * **docs/specs/21-passenger-experience.md slice 2.** Submitting no
 * longer navigates away immediately — `createdBooking` holds the
 * response and the template swaps the submit form for a held/confirmed
 * panel with a `ui-countdown`, fed from the same response's
 * `hold_expires_in_seconds` with no second request (the spec's own
 * stated reason for returning both hold fields on the create response).
 * "Continue to My Bookings" is now the passenger's own action rather
 * than an automatic redirect, so they see what they just bought before
 * leaving. This also resolves a limitation the pre-submit copy below
 * already names: this screen cannot tell an open-seating "places"
 * booking from a quick-book one before submitting (both arrive
 * identically, as a passenger count with no seat choice) — the created
 * `Booking`'s `hold_expires_in_seconds` can, because only one of the
 * two actually holds a seat (`docs/specs/10-booking-modes.md`), and the
 * post-submit copy uses that real fact instead of a form that is true
 * of both.
 */
@Component({
  selector: 'app-booking-confirm',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, BookingSteps, Alert, Button, Countdown, PageHeader],
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

  /** Null when the passenger bought places rather than seats — the
   * screen shows a passenger count instead. Not an empty string: a
   * blank "Seats:" row reads as a rendering bug rather than as a
   * service that does not assign seats. */
  protected readonly seatNumbers = computed(() => {
    const request = this.request();
    return request?.kind === 'seats'
      ? request.seats.map((seat) => seat.seatNumber).join(', ')
      : null;
  });

  protected readonly passengerCount = computed(() => {
    const request = this.request();
    if (!request) {
      return 0;
    }
    return request.kind === 'seats' ? request.seats.length : request.passengerCount;
  });

  protected readonly totalLabel = computed(() => {
    const request = this.request();
    if (!request) {
      return '';
    }
    return formatMoney(
      multiplyDecimal(request.farePerSeat, this.passengerCount()),
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
      // Two genuinely different bodies, and the backend refuses the
      // wrong one rather than ignoring the parts that do not apply
      // (docs/specs/10-booking-modes.md) — so this branch is what
      // decides whether the passenger gets what they asked for.
      body:
        request.kind === 'seats'
          ? {
              trip: request.tripId,
              seats: request.seats.map((seat) => ({
                seat: seat.id,
                from_stop: request.fromStop.id,
                to_stop: request.toStop.id,
                traveler: toTravelerBody(request.travelers[seat.id]),
              })),
            }
          : {
              trip: request.tripId,
              passenger_count: request.passengerCount,
              from_stop: request.fromStop.id,
              to_stop: request.toStop.id,
              traveler: toTravelerBody(request.traveler),
            },
    });

    this.submitting.set(false);

    if (data) {
      this.createdBooking.set(data);
      return;
    }

    if (response?.status === 409) {
      await this.returnToSeatPicker(request, SEAT_CONFLICT_NOTICE);
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
