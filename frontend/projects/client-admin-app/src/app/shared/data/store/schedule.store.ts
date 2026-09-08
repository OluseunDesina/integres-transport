import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

// The backend's `days_of_week` is a plain JSONField — drf-spectacular
// can't infer an item type for it, so openapi-typescript generates
// `unknown`. It's always a number[] in practice (validated server-side);
// narrowed here rather than casting at every call site.
export type Schedule = Omit<components['schemas']['Schedule'], 'days_of_week'> & {
  days_of_week: number[];
};

export interface ScheduleQuery {
  business?: string;
  /**
   * Free-text search, applied server-side — spec 14 slice 3a added
   * `?search=` to this endpoint precisely so `ui-filter-bar` narrows the
   * whole result set rather than the loaded page.
   */
  search?: string;
  /** Undefined means both, not "active only". */
  is_active?: boolean;
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load schedules.';
}

@Injectable({ providedIn: 'root' })
export class ScheduleStore extends ListStore<Schedule, ScheduleQuery> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: ScheduleQuery,
    page: Page
  ): Promise<{ items: Schedule[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/schedules/', {
      params: {
        query: {
          limit: page.limit,
          offset: page.offset,
          business: query.business,
          search: query.search,
          is_active: query.is_active,
        },
      },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results as Schedule[], total: data.count };
  }

  /**
   * Resolves one Schedule by id for its edit screen, which has no
   * single-record `GET` to call. Paging, the early exit and the
   * "never touch browse state" rule all live in
   * `ListStore.findByIdPaged`.
   *
   * Scoped with `{}`, not the live query: a deep link must resolve
   * whichever Business the record belongs to, regardless of which one
   * the header switcher happens to have selected. The list stays
   * Client-scoped server-side either way.
   */
  findById(id: string): Promise<Schedule | null> {
    return this.findByIdPaged(id, {});
  }
}
