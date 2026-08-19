import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';

export type Trip = components['schemas']['Trip'];
export type TicketValidationResult = components['schemas']['TicketValidationResult'];

export type ValidateTicketResult =
  | { ok: true; data: TicketValidationResult }
  | { ok: false; status: number; message: string };

function toErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return fallback;
}

/**
 * Everything the validate-ticket screen needs from the API — mirrors
 * `record-tap.service.ts`'s exact shape (one small service co-located
 * with its single consumer, not a `ListStore`).
 */
@Injectable({ providedIn: 'root' })
export class ValidateTicketService {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  private authHeader(): { Authorization: string } {
    return { Authorization: `Bearer ${this.authStore.accessToken()}` };
  }

  /**
   * Trips open for ticket validation on `serviceDate`. Unlike
   * `RecordTapService.loadTripsForDate`'s `booking_mode === 'tap_and_go'`
   * filter, this filters to the opposite — only a `reservation`-mode
   * trip's paid Bookings produce `Ticket` rows via `mark_booking_paid()`;
   * a tap_and_go trip has none to validate.
   */
  async loadTripsForDate(serviceDate: string): Promise<Trip[]> {
    const headers = this.authHeader();
    const [scheduled, inProgress] = await Promise.all([
      this.api.GET('/api/v1/trips/', {
        params: { query: { service_date: serviceDate, status: 'scheduled', limit: 100 } },
        headers,
      }),
      this.api.GET('/api/v1/trips/', {
        params: { query: { service_date: serviceDate, status: 'in_progress', limit: 100 } },
        headers,
      }),
    ]);
    const trips = [...(scheduled.data?.results ?? []), ...(inProgress.data?.results ?? [])];
    return trips
      .filter((trip) => trip.booking_mode !== 'tap_and_go')
      .sort((a, b) => a.scheduled_departure_at.localeCompare(b.scheduled_departure_at));
  }

  /** A fresh `Idempotency-Key` per submit, same reasoning as
   * `RecordTapService.recordTap` — each scan is its own deliberate
   * action, not a form resubmitted after a timeout. */
  async validateTicket(params: { tripId: string; payload: string }): Promise<ValidateTicketResult> {
    const { data, error, response } = await this.api.POST(
      '/api/v1/trips/{trip_id}/tickets/validate/',
      {
        params: {
          path: { trip_id: params.tripId },
          header: { 'Idempotency-Key': crypto.randomUUID() },
        },
        body: { payload: params.payload },
        headers: this.authHeader(),
      }
    );
    if (data) {
      return { ok: true, data };
    }
    return {
      ok: false,
      status: response?.status ?? 0,
      message: toErrorMessage(error, 'Could not validate this ticket. Try again.'),
    };
  }
}
