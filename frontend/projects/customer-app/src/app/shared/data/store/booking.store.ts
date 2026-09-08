import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

export type Booking = components['schemas']['Booking'];

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load your bookings.';
}

/**
 * The passenger's own booking history —
 * docs/specs/4-fares-seating-booking-frontend.md §4.2.
 *
 * The only `ListStore` subclass in the repo with no `TQuery`: server-side
 * scoping to `request.user` is the entire filter (`GET /bookings/mine/`),
 * and a passenger's own history has nothing to narrow by yet. Contrast
 * client-admin's own BookingStore, which does take `{trip, status}`
 * because staff are looking across everyone's.
 */
@Injectable({ providedIn: 'root' })
export class BookingStore extends ListStore<Booking> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    _query: Record<string, never>,
    page: Page
  ): Promise<{ items: Booking[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/bookings/mine/', {
      params: { query: { limit: page.limit, offset: page.offset } },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }

  /**
   * One Booking by id, for a screen that arrived holding only the id.
   *
   * `findByIdPaged` rather than a single-record GET because there is no
   * single-record GET: `/bookings/mine/` is the only endpoint a
   * passenger can read their own bookings through. The scope is passed
   * explicitly (`{}`) rather than `this.query()`, per the standing rule
   * — inheriting whatever filter the list happened to be showing is a
   * recorded bug, and this store's query is empty anyway, which is
   * exactly the sort of thing that stops being true later.
   *
   * Added for spec 17 slice 3's `report-issue`, which is handed a
   * booking id in a query param and needs the trip and operator off it.
   */
  findById(id: string): Promise<Booking | null> {
    return this.findByIdPaged(id, {});
  }
}
