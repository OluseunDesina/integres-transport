import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button } from '@shared-ui';

import type { BookingRequest, SeatPickerRequest } from '../shared/booking-draft';
import { readBookingRequest } from '../shared/booking-draft';
import { formatMoney, multiplyDecimal } from '../shared/money';

const SEAT_CONFLICT_NOTICE =
  'One of the seats you picked was taken while you were booking. Choose another.';

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
 * now" affordance anywhere on this screen (§1).
 *
 * The `Idempotency-Key` is generated once per visit rather than per
 * click, which is what makes the submit button safe to press again
 * after a timeout: the backend returns the *original* Booking for a
 * repeat of the same key and body instead of double-booking the seats
 * (§6). A genuine seat conflict is the opposite case and must not be
 * retried blindly — it sends the passenger back to the seat map, since
 * a stale selection needs a fresh availability check, not a resubmit.
 */
@Component({
  selector: 'app-booking-confirm',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, Alert, Button],
  templateUrl: './booking-confirm.html',
})
export class BookingConfirm implements OnInit {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);

  protected readonly request = signal<BookingRequest | null>(readBookingRequest(this.router));

  private readonly idempotencyKey = crypto.randomUUID();

  protected readonly submitting = signal(false);
  protected readonly submitError = signal<string | null>(null);

  protected readonly seatNumbers = computed(() =>
    (this.request()?.seats ?? []).map((seat) => seat.seatNumber).join(', ')
  );

  protected readonly totalLabel = computed(() => {
    const request = this.request();
    if (!request) {
      return '';
    }
    return formatMoney(
      multiplyDecimal(request.farePerSeat, request.seats.length),
      request.currency
    );
  });

  protected readonly fareLabel = computed(() => {
    const request = this.request();
    return request ? formatMoney(request.farePerSeat, request.currency) : '';
  });

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

    const { data, error, response } = await this.api.POST('/api/v1/bookings/', {
      // Idempotency-Key is a declared header *parameter* on this
      // operation, so it travels in params.header — unlike
      // Authorization, which every call attaches ad hoc.
      params: { header: { 'Idempotency-Key': this.idempotencyKey } },
      body: {
        trip: request.tripId,
        seats: request.seats.map((seat) => ({
          seat: seat.id,
          from_stop: request.fromStop.id,
          to_stop: request.toStop.id,
        })),
      },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    this.submitting.set(false);

    if (data) {
      // The new Booking is the first row of my-bookings, so there is no
      // separate success screen to build — the passenger lands where
      // they can see, and cancel, what they just reserved.
      await this.router.navigate(['/my-bookings']);
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
      notice,
    };
    await this.router.navigate(['/search/seats'], { state });
  }
}
