import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

export type Staff = components['schemas']['Staff'];

export interface StaffQuery {
  /**
   * Free-text search, applied server-side — spec 14 slice 3b added
   * `?search=` to this endpoint (its first query param of any kind) so
   * `ui-filter-bar` narrows the whole result set rather than the loaded
   * page.
   */
  search?: string;
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load staff.';
}

@Injectable({ providedIn: 'root' })
export class StaffStore extends ListStore<Staff, StaffQuery> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: StaffQuery,
    page: Page
  ): Promise<{ items: Staff[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/staff/', {
      params: {
        query: { limit: page.limit, offset: page.offset, search: query.search },
      },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}
