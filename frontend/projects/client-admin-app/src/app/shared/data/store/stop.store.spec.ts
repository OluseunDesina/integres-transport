import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { StopStore } from './stop.store';

describe('StopStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: StopStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(StopStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [
          {
            id: 'stop-1',
            business: 'biz-1',
            name: 'Ikeja Bus Park',
            address: '12 Awolowo Rd',
            latitude: null,
            longitude: null,
            is_active: true,
            created_at: '2026-08-06T00:00:00Z',
          },
        ],
      },
    });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/stops/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, business: undefined } },
      })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].name).toBe('Ikeja Bus Park');
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
      '/api/v1/stops/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, business: 'biz-1' } },
      })
    );
  });
});
