import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

export type Route = components['schemas']['Route'];
export type RouteDetail = components['schemas']['RouteDetail'];

export interface RouteQuery {
  business?: string;
  /**
   * Free-text search, applied server-side — spec 14 slice 3a added
   * `?search=` to this endpoint precisely so `ui-filter-bar` narrows the
   * whole result set rather than the loaded page.
   */
  search?: string;
  /**
   * docs/specs/19-route-lifecycle.md replaced `is_active` with a
   * four-state status. Undefined omits the param, which the backend
   * reads as "every status except archived" — not "every status".
   */
  status?: string;
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load routes.';
}

@Injectable({ providedIn: 'root' })
export class RouteStore extends ListStore<Route, RouteQuery> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: RouteQuery,
    page: Page
  ): Promise<{ items: Route[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/routes/', {
      params: {
        query: {
          limit: page.limit,
          offset: page.offset,
          business: query.business,
          search: query.search,
          status: query.status,
        },
      },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }

  /**
   * The detail screen's one source of stop/schedule counts and the fare
   * summary — `GET /routes/{id}/`, added in
   * docs/specs/19-route-lifecycle.md slice 1. Returns `null` on a 404
   * (deleted, or another Client's), which the caller renders as "not
   * found" rather than a failure.
   */
  async findDetail(id: string): Promise<RouteDetail | null> {
    const { data } = await this.api.GET('/api/v1/routes/{id}/', { params: { path: { id } } });
    return data ?? null;
  }

  /**
   * Resolves one Route by id for its edit screen. Delegates to
   * `findDetail` — a real single-record GET now exists (slice 1 of the
   * same spec), so this no longer needs `ListStore.findByIdPaged`'s
   * bounded-page lookup. `RouteDetail` carries every `Route` field plus
   * three read-only extras the form ignores.
   */
  findById(id: string): Promise<Route | null> {
    return this.findDetail(id);
  }
}
