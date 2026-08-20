import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
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
  private readonly authStore = inject(AuthStore);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: FareRuleQuery,
    page: Page
  ): Promise<{ items: FareRule[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/fare-rules/', {
      params: { query: { limit: page.limit, offset: page.offset, business: query.business } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}
