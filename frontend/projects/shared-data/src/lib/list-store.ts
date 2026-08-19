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

/**
 * Base for every domain list store (routes, trips, businesses, KYC
 * review queue, ...). Concrete stores live per-app at
 * `src/app/shared/data/store/<domain>.store.ts` and extend this,
 * implementing only `fetchPage()` against `@api-client` — the
 * `getAll()` / `updateQuery()` / `changePage()` shape and loading/error
 * signal handling is written once, here.
 */
export abstract class ListStore<T, TQuery = Record<string, never>> {
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
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}
