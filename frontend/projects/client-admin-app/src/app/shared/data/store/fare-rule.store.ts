import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

export type FareRule = components['schemas']['FareRule'];

export interface FareRuleQuery {
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

/** Flat-fare rules — used when `business.fare_pricing_mode === 'flat'`.
 * Mirrors `schedule.store.ts` exactly. */
@Injectable({ providedIn: 'root' })
export class FareRuleStore extends ListStore<FareRule, FareRuleQuery> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: FareRuleQuery,
    page: Page
  ): Promise<{ items: FareRule[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/fare-rules/', {
      params: {
        query: {
          limit: page.limit,
          offset: page.offset,
          business: query.business,
        },
      },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}
