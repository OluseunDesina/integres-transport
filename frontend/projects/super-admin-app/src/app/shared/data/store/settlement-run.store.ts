import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

export type SettlementRun = components['schemas']['SettlementRun'];

export interface SettlementRunQuery {
  business?: string;
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load settlement runs.';
}

/**
 * `SettlementRun` history for one Business (`GET /settlement-runs/?business=`)
 * — Phase 5 frontend Slice C. `business` is a required backend query
 * param — `fetchPage` never calls the API before it's set, same guard
 * `LedgerEntryStore` uses in client-admin-app for its own required
 * `business` param.
 */
@Injectable({ providedIn: 'root' })
export class SettlementRunStore extends ListStore<SettlementRun, SettlementRunQuery> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: SettlementRunQuery,
    page: Page
  ): Promise<{ items: SettlementRun[]; total: number }> {
    if (!query.business) {
      return { items: [], total: 0 };
    }
    const { data, error } = await this.api.GET('/api/v1/settlement-runs/', {
      params: {
        query: { limit: page.limit, offset: page.offset, business: query.business },
      },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}
