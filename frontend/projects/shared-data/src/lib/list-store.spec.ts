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
});
