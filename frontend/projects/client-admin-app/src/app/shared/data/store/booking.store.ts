import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

export type Booking = components['schemas']['Booking'];

export interface BookingQuery {
  /**
   * Added by spec 14 slice 3b. Its absence is why this list spanned
   * every Business under the Client while the header switcher claimed
   * one was active — the same gap `TripQuery` already had fixed.
   */
  business?: string;
  trip?: string;
  status?: string;
  /** Server-side match on route name or passenger email. */
  search?: string;
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load bookings.';
}

/**
 * Staff ops visibility over Bookings (`booking.view`) —
 * docs/specs/4-fares-seating-booking-frontend.md §4.3.
 *
 * Distinct from customer-app's same-named store, which reads
 * `/bookings/mine/` and takes no query at all: this one is the staff
 * `GET /bookings/` endpoint, filterable by business, trip, status and a
 * free-text search the same way `TripStore` filters its own list.
 */
@Injectable({ providedIn: 'root' })
export class BookingStore extends ListStore<Booking, BookingQuery> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: BookingQuery,
    page: Page
  ): Promise<{ items: Booking[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/bookings/', {
      params: {
        query: {
          limit: page.limit,
          offset: page.offset,
          business: query.business,
          trip: query.trip,
          status: query.status,
          search: query.search,
        },
      },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}
