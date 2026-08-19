import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
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
  private readonly authStore = inject(AuthStore);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    _query: Record<string, never>,
    page: Page
  ): Promise<{ items: Booking[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/bookings/mine/', {
      params: { query: { limit: page.limit, offset: page.offset } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}
