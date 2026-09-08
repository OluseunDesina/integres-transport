import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { RouteStore } from './route.store';

describe('RouteStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: RouteStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(RouteStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [
          {
            id: 'route-1',
            business: 'biz-1',
            name: 'Ikeja Express',
            code: '',
            description: '',
            status: 'active',
            stops: [],
            created_at: '2026-08-06T00:00:00Z',
          },
        ],
      },
    });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/routes/',
      jasmine.objectContaining({
        params: {
          query: {
            limit: 25,
            offset: 0,
            business: undefined,
            search: undefined,
            status: undefined,
          },
        },
      })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].name).toBe('Ikeja Express');
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
      '/api/v1/routes/',
      jasmine.objectContaining({
        params: {
          query: {
            limit: 25,
            offset: 0,
            business: 'biz-1',
            search: undefined,
            status: undefined,
          },
        },
      })
    );
  });

  it('narrows by status via updateQuery()', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await store.updateQuery({ status: 'archived' });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/routes/',
      jasmine.objectContaining({
        params: { query: jasmine.objectContaining({ status: 'archived' }) },
      })
    );
  });

  describe('findDetail', () => {
    it('calls the single-record GET and returns its body', async () => {
      const detail = { id: 'route-1', name: 'Ikeja Express', stop_count: 2, schedule_count: 1 };
      apiClient.GET.and.resolveTo({ data: detail });

      const found = await store.findDetail('route-1');

      expect(apiClient.GET).toHaveBeenCalledWith('/api/v1/routes/{id}/', {
        params: { path: { id: 'route-1' } },
      });
      expect(found).toEqual(jasmine.objectContaining({ id: 'route-1', stop_count: 2 }));
    });

    it('returns null on a 404 rather than throwing', async () => {
      apiClient.GET.and.resolveTo({ error: { detail: 'Not found.' } });

      expect(await store.findDetail('nope')).toBeNull();
    });
  });

  describe('findById', () => {
    it('delegates to the single-record GET, not a bounded page', async () => {
      apiClient.GET.and.resolveTo({ data: { id: 'route-1', name: 'Ikeja Express' } });

      const found = await store.findById('route-1');

      expect(apiClient.GET).toHaveBeenCalledWith('/api/v1/routes/{id}/', {
        params: { path: { id: 'route-1' } },
      });
      expect(found?.id).toBe('route-1');
    });

    it('returns null when the record does not exist', async () => {
      apiClient.GET.and.resolveTo({ error: { detail: 'Not found.' } });

      expect(await store.findById('nope')).toBeNull();
    });
  });
});
