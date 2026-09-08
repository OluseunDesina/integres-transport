import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';

export type Trip = components['schemas']['Trip'];

/** Generous enough that no operator's day of service exceeds it, and
 * the same "unpaginated picker" tradeoff every other picker in this
 * codebase already takes. */
const PAGE_LIMIT = 100;

/**
 * Every trip a validator could be working on `serviceDate`.
 *
 * Extracted for spec 17 slice 3, when a third screen needed the same
 * set. `RecordTapService` and `ValidateTicketService` had each written
 * this out, identically, and `ReportIssueService` would have been the
 * third copy of a query with two non-obvious properties in it:
 *
 * - **Two requests, merged.** `TripListQuerySerializer.status` accepts
 *   one value per request, so `scheduled` and `in_progress` cannot be
 *   asked for together.
 * - **No `fare_collection_mode` filter.** A tap credential is universal
 *   fare media (docs/specs/10-booking-modes.md), so filtering either
 *   mode out here would make one of them unreachable. Callers that need
 *   a narrower set filter the result — `ValidateTicketService` keeps
 *   prepaid trips only, because a pay-as-you-go trip has no tickets to
 *   validate.
 *
 * Sorted by departure, because a conductor reads this list as a
 * timetable.
 */
@Injectable({ providedIn: 'root' })
export class OpenTripsService {
  private readonly api = inject(API_CLIENT);

  async loadForDate(serviceDate: string): Promise<Trip[]> {
    const [scheduled, inProgress] = await Promise.all([
      this.api.GET('/api/v1/trips/', {
        params: { query: { service_date: serviceDate, status: 'scheduled', limit: PAGE_LIMIT } },
      }),
      this.api.GET('/api/v1/trips/', {
        params: {
          query: { service_date: serviceDate, status: 'in_progress', limit: PAGE_LIMIT },
        },
      }),
    ]);
    const trips = [...(scheduled.data?.results ?? []), ...(inProgress.data?.results ?? [])];
    return trips.sort((a, b) =>
      a.scheduled_departure_at.localeCompare(b.scheduled_departure_at)
    );
  }
}
