import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { ListStore, type Page } from '@shared-data';

export type Trip = components['schemas']['Trip'];

// First real multi-key TQuery consumer — TripStore exercises
// ListStore.updateQuery() with more than a single `business` filter.
export interface TripQuery {
  route?: string;
  schedule?: string;
  service_date?: string;
  status?: string;
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load trips.';
}

@Injectable({ providedIn: 'root' })
export class TripStore extends ListStore<Trip, TripQuery> {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: TripQuery,
    page: Page
  ): Promise<{ items: Trip[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/trips/', {
      params: {
        query: {
          limit: page.limit,
          offset: page.offset,
          route: query.route,
          schedule: query.schedule,
          service_date: query.service_date,
          status: query.status,
        },
      },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}
