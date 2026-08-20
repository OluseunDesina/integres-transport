import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { ListStore, type Page } from '@shared-data';

export type FareJourney = components['schemas']['FareJourney'];

export interface FareJourneyQuery {
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
 * `GET /fare-journeys/` has no `?business=` filter (unlike every other
 * staff list endpoint this workspace's stores wrap) — it's already
 * scoped to the caller's own Client by `TenantScopedManager`, across
 * every Business that Client runs, matching
 * `apps.tapngo.views.FareJourneyListView.get_queryset`'s own shape.
 * `status` is the only supported filter.
 */
@Injectable({ providedIn: 'root' })
export class FareJourneyStore extends ListStore<FareJourney, FareJourneyQuery> {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: FareJourneyQuery,
    page: Page
  ): Promise<{ items: FareJourney[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/fare-journeys/', {
      params: { query: { limit: page.limit, offset: page.offset, status: query.status } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}
