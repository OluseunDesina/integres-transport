import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

export type BusinessSuperAdmin = components['schemas']['BusinessSuperAdmin'];

export interface BusinessSuperAdminQuery {
  search?: string;
  kyb_status?: BusinessSuperAdmin['kyb_status'];
  vertical?: BusinessSuperAdmin['vertical'];
  /**
   * A string, not a boolean — matches the query param the backend
   * actually accepts (`apps.businesses.serializers.BusinessSuperAdminQuerySerializer`
   * declares it as a `"true"`/`"false"` `ChoiceField`, not a
   * `BooleanField`: a plain optional boolean silently resolves a missing
   * key to `false` under DRF's HTML-form `get_value()` semantics, which
   * would filter out every active Business on an unfiltered request).
   */
  is_active?: 'true' | 'false';
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
 * Cross-client Business search for platform staff (`GET /super-admin/
 * businesses/`) — Phase 5 frontend Slice C. `providedIn: 'root'`
 * deliberately: the Paystack-config and settlement-run screens have no
 * single-Business GET to fetch from, so they resolve a Business via
 * this same singleton's `findById()` instead — the same "no GET
 * /businesses/{id}/, reuse the list store" pattern `business-form.ts`
 * established in client-admin-app for its own edit mode.
 */
@Injectable({ providedIn: 'root' })
export class BusinessSuperAdminStore extends ListStore<
  BusinessSuperAdmin,
  BusinessSuperAdminQuery
> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: BusinessSuperAdminQuery,
    page: Page
  ): Promise<{ items: BusinessSuperAdmin[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/super-admin/businesses/', {
      params: {
        query: {
          limit: page.limit,
          offset: page.offset,
          search: query.search,
          kyb_status: query.kyb_status,
          vertical: query.vertical,
          is_active: query.is_active,
        },
      },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }

  /**
   * Resolves a single Business by id for `paystack-config.ts`/
   * `settlement-runs.ts`, which have no single-Business GET to call
   * (see this class's own docstring).
   *
   * The paging and the "never touch browse state" rule live in
   * `ListStore.findByIdPaged`; this store only supplies the scope, and
   * the scope is deliberately the **unfiltered** cross-client list.
   * Passing `{}` rather than the live query is the fix for a real bug:
   * a lookup that reused a leftover `search=` from `business-list.ts`
   * reported "Business not found" for a Business that existed.
   */
  findById(id: string): Promise<BusinessSuperAdmin | null> {
    return this.findByIdPaged(id, {});
  }
}
