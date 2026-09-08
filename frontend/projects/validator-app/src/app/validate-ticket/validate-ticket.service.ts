import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';

import { OpenTripsService } from '../shared/open-trips.service';

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
  private readonly openTrips = inject(OpenTripsService);


  /**
   * Trips open for ticket validation on `serviceDate`. Exactly the
   * complement of `RecordTapService.loadTripsForDate`'s filter: a
   * prepaid trip is the one whose paid Bookings produce `Ticket` rows
   * via `mark_booking_paid()`, and a pay-as-you-go trip has none to
   * validate because nothing was bought in advance.
   *
   * Note this now admits **open-seating** trips too, which the old
   * `booking_mode !== 'tap_and_go'` test also did but for the wrong
   * reason — what matters is that the trip is prepaid, not that its
   * seats are assigned (docs/specs/10-booking-modes.md).
   */
  async loadTripsForDate(serviceDate: string): Promise<Trip[]> {
    // The filter is the only thing this adds to the shared loader, and
    // it is the whole difference between this screen and /record.
    const trips = await this.openTrips.loadForDate(serviceDate);
    return trips.filter((trip) => trip.fare_collection_mode === 'prepaid');
  }

  /** A fresh `Idempotency-Key` per submit, same reasoning as
   * `RecordTapService.recordTap` — each scan is its own deliberate
   * action, not a form resubmitted after a timeout. */
  async validateTicket(params: { tripId: string; payload: string }): Promise<ValidateTicketResult> {
    return this.post(params.tripId, { payload: params.payload });
  }

  /**
   * The same endpoint reached with a tap credential instead of a
   * scanned QR — docs/specs/10-booking-modes.md's universal tap. The
   * backend resolves the token to the Ticket that passenger already
   * holds, so the result is identical in shape and this needs no
   * separate handling.
   *
   * Lives here rather than on `RecordTapService`, even though
   * `record-tap` is what calls it: one service owns one endpoint, and a
   * second POST to this path would be a copy to keep in step.
   */
  async validateCredential(params: {
    tripId: string;
    token: string;
  }): Promise<ValidateTicketResult> {
    return this.post(params.tripId, { token: params.token });
  }

  private async post(
    tripId: string,
    body: { payload: string } | { token: string }
  ): Promise<ValidateTicketResult> {
    const { data, error, response } = await this.api.POST(
      '/api/v1/trips/{trip_id}/tickets/validate/',
      {
        params: {
          path: { trip_id: tripId },
          header: { 'Idempotency-Key': crypto.randomUUID() },
        },
        body,
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
