import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { ListStore, type Page } from '@shared-data';

export type FareSegmentRule = components['schemas']['FareSegmentRule'];

export interface FareSegmentRuleQuery {
  business?: string;
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load fares.';
}

/** Per-segment fare rules — used when
 * `business.fare_pricing_mode === 'per_segment'`. Mirrors
 * `fare-rule.store.ts` exactly. */
@Injectable({ providedIn: 'root' })
export class FareSegmentRuleStore extends ListStore<FareSegmentRule, FareSegmentRuleQuery> {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: FareSegmentRuleQuery,
    page: Page
  ): Promise<{ items: FareSegmentRule[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/fare-segment-rules/', {
      params: { query: { limit: page.limit, offset: page.offset, business: query.business } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}
