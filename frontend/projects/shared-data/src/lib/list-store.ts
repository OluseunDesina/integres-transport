import { type Signal, type WritableSignal, computed, signal } from '@angular/core';

export interface Page {
  limit: number;
  offset: number;
}

interface ListState<T, TQuery> {
  items: T[];
  total: number;
  query: TQuery;
  page: Page;
  loading: boolean;
  error: string | null;
}

/** Page size `findByIdPaged` fetches with — deliberately larger than any
 * browse page size, since nobody is reading these rows. */
const LOOKUP_PAGE_SIZE = 100;
/** A hard safety cap on how many pages `findByIdPaged` will ever
 * request, not an expected ceiling. */
const LOOKUP_MAX_PAGES = 50;

/**
 * Base for every domain list store (routes, trips, businesses, KYC
 * review queue, ...). Concrete stores live per-app at
 * `src/app/shared/data/store/<domain>.store.ts` and extend this,
 * implementing only `fetchPage()` against `@api-client` — the
 * `getAll()` / `updateQuery()` / `changePage()` shape and loading/error
 * signal handling is written once, here.
 *
 * `T extends { id: string }` so `findByIdPaged` below can match without
 * every caller passing a predicate. Every concrete store's `T` is a
 * generated `components['schemas'][...]` type and already satisfies it.
 */
export abstract class ListStore<T extends { id: string }, TQuery = Record<string, never>> {
  private readonly state: WritableSignal<ListState<T, TQuery>>;

  readonly items: Signal<T[]>;
  readonly total: Signal<number>;
  readonly query: Signal<TQuery>;
  readonly page: Signal<Page>;
  readonly loading: Signal<boolean>;
  readonly error: Signal<string | null>;
  readonly isEmpty: Signal<boolean>;

  protected constructor(initialQuery: TQuery, pageSize = 25) {
    this.state = signal<ListState<T, TQuery>>({
      items: [],
      total: 0,
      query: initialQuery,
      page: { limit: pageSize, offset: 0 },
      loading: false,
      error: null,
    });

    this.items = computed(() => this.state().items);
    this.total = computed(() => this.state().total);
    this.query = computed(() => this.state().query);
    this.page = computed(() => this.state().page);
    this.loading = computed(() => this.state().loading);
    this.error = computed(() => this.state().error);
    this.isEmpty = computed(() => !this.state().loading && this.state().items.length === 0);
  }

  protected abstract fetchPage(
    query: TQuery,
    page: Page
  ): Promise<{ items: T[]; total: number }>;

  async getAll(): Promise<void> {
    const { query, page } = this.state();
    this.state.update((s) => ({ ...s, loading: true, error: null }));
    try {
      const { items, total } = await this.fetchPage(query, page);
      this.state.update((s) => ({ ...s, items, total, loading: false }));
    } catch (err) {
      this.state.update((s) => ({ ...s, loading: false, error: toErrorMessage(err) }));
    }
  }

  async updateQuery(partial: Partial<TQuery>): Promise<void> {
    this.state.update((s) => ({
      ...s,
      query: { ...s.query, ...partial },
      page: { ...s.page, offset: 0 },
    }));
    await this.getAll();
  }

  async changePage(offset: number): Promise<void> {
    this.state.update((s) => ({ ...s, page: { ...s.page, offset } }));
    await this.getAll();
  }

  /**
   * Resolves one row by id for a detail/edit screen, checking the
   * already-loaded page first and then paging the list until it turns
   * up. Returns `null` if it is in no page.
   *
   * **Why this exists.** Detail screens have no single-record `GET` to
   * call for most domains, so they used to resolve from `items()`,
   * re-run `getAll()` once, and give up — which reports "not found" for
   * any record outside the store's *current* page. On a refresh, a
   * pasted link, or a new tab that page is page 1, so anything past row
   * 25 was unreachable. The codebase fixed that by hand three times
   * (`SelectedBusinessStore`, `BusinessSuperAdminStore`, then
   * `BusinessStore`) before it was written once, here.
   *
   * **`query` is required, never defaulted to `this.query()`.** A
   * lookup that inherited the live query would inherit whatever filter
   * the *list* screen happened to leave behind — a real bug already
   * recorded for `super-admin-app`, where a leftover `search=` made a
   * direct navigation report "Business not found" for a business that
   * existed. Callers pass the scope they actually mean (usually the
   * store's initial query, or a business id).
   *
   * **Deliberately does not touch `state`.** `fetchPage` is called
   * directly rather than through `getAll()`/`changePage()`, so a lookup
   * from a detail screen can never clobber the list screen's own
   * `items`/`total`/`page` if the operator navigates back to it.
   *
   * Early-exits on the first match, so the common case — a list that
   * fits in one lookup page — costs exactly one request.
   */
  protected async findByIdPaged(id: string, query: TQuery): Promise<T | null> {
    const cached = this.items().find((item) => item.id === id);
    if (cached) {
      return cached;
    }
    for (let page = 0; page < LOOKUP_MAX_PAGES; page++) {
      const offset = page * LOOKUP_PAGE_SIZE;
      let items: T[];
      let total: number;
      try {
        ({ items, total } = await this.fetchPage(query, { limit: LOOKUP_PAGE_SIZE, offset }));
      } catch {
        // Resolves to "not found" rather than rejecting: callers await
        // this straight from `ngOnInit` and render a not-found state, so
        // a rejection here would surface as an unhandled promise instead
        // of anything the operator can read. Matches what all three
        // hand-written predecessors did. The cost is that a network
        // failure is indistinguishable from a genuinely missing record —
        // acceptable while `error` on the list screen still reports the
        // failure, and worth revisiting if a screen ever needs to retry.
        return null;
      }
      const match = items.find((item) => item.id === id);
      if (match) {
        return match;
      }
      if (items.length < LOOKUP_PAGE_SIZE || offset + LOOKUP_PAGE_SIZE >= total) {
        return null;
      }
    }
    return null;
  }
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}
