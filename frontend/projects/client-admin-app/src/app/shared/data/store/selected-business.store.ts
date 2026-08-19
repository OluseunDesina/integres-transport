import { Injectable, inject, signal } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';

export type Business = components['schemas']['Business'];

const STORAGE_KEY = 'integra.business.selected';
const PAGE_SIZE = 100;
// A hard safety cap on how many pages `fetchAllBusinesses` will ever
// request, not an expected ceiling — see that method's own docstring.
const MAX_PAGES = 50;

/**
 * Persists the active-Business selection driving Routes/Stops list
 * scoping and the profile menu's business switcher — mirrors
 * NavCollapseStore's restore/persist shape, but unlike that store this
 * one needs the real Business list (to validate a persisted id still
 * exists, and to pick a default) before it can settle, so
 * initialization is a lazy, idempotent `ensureLoaded()` — called once
 * from AppShell's constructor (the persistent parent for every
 * authenticated route), not a boot-time `provideAppInitializer` like
 * WhiteLabelResolverService: the Business list endpoint is
 * authenticated, and there's no access token yet at app-bootstrap time
 * on a fresh login.
 *
 * A fresh fetch, not a reuse of BusinessStore — deliberately, so an
 * unrelated screen's own pagination state can't silently affect what
 * "first Business" means for this cross-cutting concern. Pages through
 * the *entire* list (see `fetchAllBusinesses`), not a single bounded
 * page — a single `limit=100` fetch (the original shape here, matching
 * `BusinessOptionsService`'s own precedent) was a real, live bug: once
 * a Client accumulated more than 100 Businesses, a persisted
 * `selectedBusinessId` beyond that window silently fell back to "first
 * Business in the page" instead of resolving to the one the operator
 * actually had active — misdirecting every business-scoped screen this
 * store feeds (including the pre-filled Business field on several
 * create forms) with no error at all. `BusinessOptionsService` keeps
 * its own single-page fetch — it only renders a dropdown, where a
 * missing option is at least visible, not a silent wrong selection.
 */
@Injectable({ providedIn: 'root' })
export class SelectedBusinessStore {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  private readonly businesses = signal<Business[]>([]);
  private readonly selectedId = signal<string | null>(this.restore());
  private readonly loading = signal(false);
  private loadPromise: Promise<void> | null = null;

  readonly items = this.businesses.asReadonly();
  readonly selectedBusinessId = this.selectedId.asReadonly();
  readonly isLoading = this.loading.asReadonly();

  /** Idempotent — safe to call from every AppShell construction; only
   * the first call actually fetches. */
  async ensureLoaded(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }
    this.loadPromise = this.load();
    return this.loadPromise;
  }

  async select(businessId: string): Promise<void> {
    this.selectedId.set(businessId);
    this.persist(businessId);
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    const items = await this.fetchAllBusinesses();
    this.businesses.set(items);
    this.loading.set(false);

    // A persisted id from a prior session might no longer exist (the
    // Business was archived, or this is a different account sharing a
    // browser) — fall back to "first" whenever the persisted choice
    // doesn't resolve against the fresh list, same as having none.
    const persisted = this.selectedId();
    const stillValid = persisted !== null && items.some((b) => b.id === persisted);
    if (!stillValid) {
      const first = items[0]?.id ?? null;
      this.selectedId.set(first);
      if (first) {
        this.persist(first);
      }
    }
  }

  // The backend sets no `max_limit` on `LimitOffsetPagination` (a plain
  // `?limit=` is honored no matter how large), so this loops rather
  // than trusting one page — the common case (well under PAGE_SIZE
  // Businesses) is still exactly one request. `MAX_PAGES` only bounds
  // worst case: a Client with more Businesses than that isn't a case
  // this codebase has ever supported being correct for, just not one
  // this loop is allowed to hang on forever.
  private async fetchAllBusinesses(): Promise<Business[]> {
    const headers = { Authorization: `Bearer ${this.authStore.accessToken()}` };
    const items: Business[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data } = await this.api.GET('/api/v1/businesses/', {
        params: { query: { limit: PAGE_SIZE, offset } },
        headers,
      });
      if (!data) {
        break;
      }
      items.push(...data.results);
      if (data.results.length < PAGE_SIZE || items.length >= data.count) {
        break;
      }
      offset += PAGE_SIZE;
    }
    return items;
  }

  private restore(): string | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    try {
      return (JSON.parse(raw) as string | null) ?? null;
    } catch {
      return null;
    }
  }

  private persist(businessId: string): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(businessId));
    }
  }
}
