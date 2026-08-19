import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { ListStore, type Page } from '@shared-data';

export type BusinessSuperAdmin = components['schemas']['BusinessSuperAdmin'];

export interface BusinessSuperAdminQuery {
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

const LOOKUP_PAGE_SIZE = 100;
// A hard safety cap on how many pages `findById` will ever request, not
// an expected ceiling — see that method's own docstring.
const LOOKUP_MAX_PAGES = 50;

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
  private readonly authStore = inject(AuthStore);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: BusinessSuperAdminQuery,
    page: Page
  ): Promise<{ items: BusinessSuperAdmin[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/super-admin/businesses/', {
      params: {
        query: { limit: page.limit, offset: page.offset, search: query.search },
      },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }

  /**
   * Resolves a single Business by id for `paystack-config.ts`/
   * `settlement-runs.ts`, which have no single-Business GET to call
   * (see this class's own docstring). Checks the already-loaded page
   * first, then pages through the *entire*, unfiltered cross-client
   * list directly against the API — deliberately not through
   * `getAll()`/`updateQuery()`, so a lookup from either of those
   * screens can never clobber `business-list.ts`'s own paginated
   * browse state (`items`/`total`/`page`) if the operator navigates
   * back to it. Was a real, live bug before this method existed: both
   * callers did one bounded `limit=25` fetch and gave up, so any
   * Business past the first unfiltered page silently reported "not
   * found" (confirmed against this dev DB's 145 leftover e2e
   * Businesses). Early-exits the moment a match is found rather than
   * always fetching every page.
   */
  async findById(id: string): Promise<BusinessSuperAdmin | null> {
    const cached = this.items().find((b) => b.id === id);
    if (cached) {
      return cached;
    }
    const headers = { Authorization: `Bearer ${this.authStore.accessToken()}` };
    let offset = 0;
    for (let page = 0; page < LOOKUP_MAX_PAGES; page++) {
      const { data } = await this.api.GET('/api/v1/super-admin/businesses/', {
        params: { query: { limit: LOOKUP_PAGE_SIZE, offset } },
        headers,
      });
      if (!data) {
        return null;
      }
      const match = data.results.find((b) => b.id === id);
      if (match) {
        return match;
      }
      if (data.results.length < LOOKUP_PAGE_SIZE || offset + LOOKUP_PAGE_SIZE >= data.count) {
        return null;
      }
      offset += LOOKUP_PAGE_SIZE;
    }
    return null;
  }
}
