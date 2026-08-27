import { Injectable } from '@angular/core';

import { type Page, ListStore } from './list-store';

interface Widget {
  id: string;
  name: string;
}

interface WidgetQuery {
  search: string;
}

@Injectable()
class WidgetStore extends ListStore<Widget, WidgetQuery> {
  fetchPageSpy = jasmine.createSpy('fetchPage');

  constructor() {
    super({ search: '' });
  }

  protected override fetchPage(
    query: WidgetQuery,
    page: Page
  ): Promise<{ items: Widget[]; total: number }> {
    return this.fetchPageSpy(query, page);
  }

  /** The shape every concrete store uses: expose a public lookup that
   * supplies the scope it means, rather than inheriting the live query. */
  findById(id: string): Promise<Widget | null> {
    return this.findByIdPaged(id, { search: '' });
  }
}

describe('ListStore', () => {
  let store: WidgetStore;

  beforeEach(() => {
    store = new WidgetStore();
  });

  it('starts empty, not loading, with no error', () => {
    expect(store.items()).toEqual([]);
    expect(store.total()).toBe(0);
    expect(store.loading()).toBeFalse();
    expect(store.error()).toBeNull();
    expect(store.isEmpty()).toBeTrue();
  });

  it('getAll() populates items/total from fetchPage()', async () => {
    store.fetchPageSpy.and.resolveTo({
      items: [{ id: '1', name: 'Widget' }],
      total: 1,
    });

    await store.getAll();

    expect(store.items()).toEqual([{ id: '1', name: 'Widget' }]);
    expect(store.total()).toBe(1);
    expect(store.loading()).toBeFalse();
    expect(store.isEmpty()).toBeFalse();
  });

  it('getAll() surfaces a failure as the error signal, not a throw', async () => {
    store.fetchPageSpy.and.rejectWith(new Error('network down'));

    await store.getAll();

    expect(store.error()).toBe('network down');
    expect(store.loading()).toBeFalse();
  });

  it('updateQuery() merges the query, resets to page 0, and refetches', async () => {
    store.fetchPageSpy.and.resolveTo({ items: [], total: 0 });
    await store.changePage(50);

    await store.updateQuery({ search: 'bus' });

    expect(store.query()).toEqual({ search: 'bus' });
    expect(store.page().offset).toBe(0);
    expect(store.fetchPageSpy).toHaveBeenCalledTimes(2);
  });

  it('changePage() updates the page offset and refetches', async () => {
    store.fetchPageSpy.and.resolveTo({ items: [], total: 0 });

    await store.changePage(25);

    expect(store.page()).toEqual({ limit: 25, offset: 25 });
    expect(store.fetchPageSpy).toHaveBeenCalledWith({ search: '' }, { limit: 25, offset: 25 });
  });

  describe('findByIdPaged()', () => {
    /** `total` widgets named `w-<n>`, served from whatever offset the
     * caller asks for. */
    function stubList(total: number): void {
      store.fetchPageSpy.and.callFake((_query: WidgetQuery, page: Page) => {
        const size = Math.max(0, Math.min(page.limit, total - page.offset));
        return Promise.resolve({
          items: Array.from({ length: size }, (_, i) => ({
            id: `w-${page.offset + i}`,
            name: `Widget ${page.offset + i}`,
          })),
          total,
        });
      });
    }

    it('resolves a row that lies past the browse page', async () => {
      // The whole reason this exists. Detail screens used to check one
      // bounded page and give up, so anything past it reported
      // "not found" on a refresh or a pasted link.
      stubList(500);

      expect((await store.findById('w-321'))?.id).toBe('w-321');
    });

    it('returns null for an id that is in no page', async () => {
      stubList(500);

      expect(await store.findById('w-9999')).toBeNull();
    });

    it('costs one request when the list fits in a single lookup page', async () => {
      stubList(30);

      await store.findById('w-29');

      expect(store.fetchPageSpy).toHaveBeenCalledTimes(1);
    });

    it('answers from the already-loaded page without fetching at all', async () => {
      store.fetchPageSpy.and.resolveTo({ items: [{ id: 'w-1', name: 'Widget 1' }], total: 1 });
      await store.getAll();
      store.fetchPageSpy.calls.reset();

      expect((await store.findById('w-1'))?.id).toBe('w-1');
      expect(store.fetchPageSpy).not.toHaveBeenCalled();
    });

    it('never disturbs the browse state it is called alongside', async () => {
      // A lookup from a detail screen must not reset the list screen's
      // pagination — the defect `BusinessSuperAdminStore` was written to
      // avoid, now guaranteed for every store at once.
      stubList(500);
      await store.changePage(25);
      const browsed = store.items();

      await store.findById('w-400');

      expect(store.items()).toBe(browsed);
      expect(store.page()).toEqual({ limit: 25, offset: 25 });
      expect(store.total()).toBe(500);
    });

    it('uses the scope it is given, not whatever the list screen left behind', async () => {
      // Inheriting the live query is exactly how a leftover `search=`
      // once made a direct navigation report "not found" for a record
      // that existed.
      stubList(10);
      await store.updateQuery({ search: 'stale filter' });
      store.fetchPageSpy.calls.reset();

      await store.findById('w-500');

      expect(store.fetchPageSpy).toHaveBeenCalledWith({ search: '' }, jasmine.anything());
    });

    it('resolves to null rather than rejecting when the fetch fails', async () => {
      // Callers await this straight from ngOnInit and render a not-found
      // state; a rejection would surface as an unhandled promise.
      store.fetchPageSpy.and.rejectWith(new Error('network down'));

      await expectAsync(store.findById('w-1')).toBeResolvedTo(null);
    });
  });
});
