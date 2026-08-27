import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { ListStore, type Page } from '@shared-data';

export type Business = components['schemas']['Business'];

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
 * Authenticated endpoints have no global auth-header attachment on
 * `API_CLIENT` (only `AuthApiService.fetchCurrentUser` sets one, on the
 * single request it makes right after login) — every other authenticated
 * call site attaches its own `Authorization` header explicitly, same as
 * here.
 */
@Injectable({ providedIn: 'root' })
export class BusinessStore extends ListStore<Business> {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    _query: Record<string, never>,
    page: Page
  ): Promise<{ items: Business[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/businesses/', {
      params: { query: { limit: page.limit, offset: page.offset } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
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
   * scope. `GET /businesses/` is already Client-scoped server-side and
   * takes no filter of its own, so the scope is the empty query.
   */
  findById(id: string): Promise<Business | null> {
    return this.findByIdPaged(id, {});
  }
}
