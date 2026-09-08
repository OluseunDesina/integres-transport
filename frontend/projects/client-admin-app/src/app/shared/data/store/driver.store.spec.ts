import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { DriverStore } from './driver.store';

interface LookupQuery {
  limit: number;
  offset: number;
}

describe('DriverStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: DriverStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(DriverStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [
          {
            id: 'd-1',
            business: 'biz-1',
            name: 'Tunde Bello',
            phone: '',
            license_number: 'DL-000123',
            license_expires_at: null,
            is_active: true,
            compliance_warnings: [],
            created_at: '2026-08-06T00:00:00Z',
          },
        ],
      },
    });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/drivers/',
      jasmine.objectContaining({
        params: {
          query: {
            limit: 25,
            offset: 0,
            business: undefined,
            search: undefined,
            is_active: undefined,
          },
        },
      })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].name).toBe('Tunde Bello');
    expect(store.total()).toBe(1);
  });

  it('surfaces the server error message on failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

    await store.getAll();

    expect(store.error()).toBe('Forbidden.');
    expect(store.items()).toEqual([]);
  });

  it('scopes the request to a Business via updateQuery()', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await store.updateQuery({ business: 'biz-1' });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/drivers/',
      jasmine.objectContaining({
        params: {
          query: {
            limit: 25,
            offset: 0,
            business: 'biz-1',
            search: undefined,
            is_active: undefined,
          },
        },
      })
    );
  });
  describe('findById', () => {
    it('resolves a record past the browse page, unfiltered by the live query', async () => {
      // Two things at once, because they failed together: the lookup
      // must page past row 25 (the bounded form reported "not found" on
      // any refresh or deep link), and it must NOT inherit whatever
      // filter the list screen left behind — a deep link has to resolve
      // whichever Business the record belongs to.
      apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });
      await store.updateQuery({ business: 'biz-other' });
      apiClient.GET.calls.reset();
      apiClient.GET.and.callFake((_path: string, init: { params: { query: LookupQuery } }) => {
        const { limit, offset } = init.params.query;
        const results = Array.from(
          { length: Math.max(0, Math.min(limit, 300 - offset)) },
          (_, i) => ({
            id: 'rec-' + (offset + i),
          })
        );
        return Promise.resolve({ data: { count: 300, results } });
      });

      const found = await store.findById('rec-250');

      expect(found?.id).toBe('rec-250');
      expect(apiClient.GET).toHaveBeenCalledWith(
        '/api/v1/drivers/',
        jasmine.objectContaining({
          params: {
            query: {
              limit: 100,
              offset: 0,
              business: undefined,
              search: undefined,
              is_active: undefined,
            },
          },
        })
      );
    });

    it('returns null for an id in no page', async () => {
      apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

      expect(await store.findById('nope')).toBeNull();
    });
  });
});
