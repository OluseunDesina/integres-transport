import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

export type FareJourney = components['schemas']['FareJourney'];

export interface FareJourneyQuery {
  /**
   * Added by spec 14 slice 3b. Its absence is why this list spanned
   * every Business under the Client while the header switcher claimed
   * one was active. A FareJourney has no business of its own — it
   * belongs to one through its Trip, which is where the backend filter
   * reaches.
   */
  business?: string;
  status?: string;
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load tap-and-go journeys.';
}

/**
 * `GET /fare-journeys/` gained `?business=` in spec 14 slice 3b. Before
 * that it was Client-scoped only — correct for tenancy, but it meant
 * this screen listed every Business the Client runs while the header
 * switcher claimed one was active, the same gap `BookingStore` had.
 */
@Injectable({ providedIn: 'root' })
export class FareJourneyStore extends ListStore<FareJourney, FareJourneyQuery> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: FareJourneyQuery,
    page: Page
  ): Promise<{ items: FareJourney[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/fare-journeys/', {
      params: {
        query: {
          limit: page.limit,
          offset: page.offset,
          business: query.business,
          status: query.status,
        },
      },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}
