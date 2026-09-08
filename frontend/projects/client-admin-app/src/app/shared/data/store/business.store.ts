import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

export type Business = components['schemas']['Business'];

export interface BusinessQuery {
  /**
   * Server-side match on the business name — spec 14 slice 3b added
   * `?search=` to this endpoint, its first query param of any kind.
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
  return 'Failed to load businesses.';
}

/**
 * No `Authorization` header here, or anywhere else: `@auth`'s
 * `authMiddleware` attaches it to every request on `API_CLIENT` and
 * refreshes it on a 401 (docs/specs/13-session-resilience.md).
 *
 * The single exception in the workspace is
 * `AuthApiService.fetchCurrentUser`, which passes a token that is not in
 * the store yet.
 */
@Injectable({ providedIn: 'root' })
export class BusinessStore extends ListStore<Business, BusinessQuery> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: BusinessQuery,
    page: Page
  ): Promise<{ items: Business[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/businesses/', {
      params: {
        query: { limit: page.limit, offset: page.offset, search: query.search },
      },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }

  /**
   * Resolves a single Business by id for `business-form.ts` (edit mode)
   * and `business-kyb.ts`, neither of which has a single-Business GET to
   * call — there is no `GET /businesses/{id}/`.
   *
   * The paging, the early exit and the "never touch browse state" rule
   * all live in `ListStore.findByIdPaged` — this store only supplies the
   * scope. Deliberately the *empty* query, not `this.query()`: a lookup
   * must resolve a Business whatever the list screen happens to be
   * filtered to. Inheriting a live filter here is itself a recorded bug
   * (docs/self-check-2026-08-26-spec11.md).
   */
  findById(id: string): Promise<Business | null> {
    return this.findByIdPaged(id, {});
  }
}
