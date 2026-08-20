import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { ListStore, type Page } from '@shared-data';

export type FareJourney = components['schemas']['FareJourney'];

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load your journeys.';
}

/**
 * The passenger's own Tap & Go ride history (`GET /fare-journeys/mine/`)
 * — mirrors `BookingStore`'s own shape exactly: server-side scoping to
 * `request.user` is the entire filter, no `TQuery` needed.
 */
@Injectable({ providedIn: 'root' })
export class FareJourneyStore extends ListStore<FareJourney> {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    _query: Record<string, never>,
    page: Page
  ): Promise<{ items: FareJourney[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/fare-journeys/mine/', {
      params: { query: { limit: page.limit, offset: page.offset } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}
