import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { VehicleTypeStore } from './vehicle-type.store';

describe('VehicleTypeStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: VehicleTypeStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(VehicleTypeStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [
          {
            id: 'vt-1',
            business: 'biz-1',
            name: '33-seater coaster',
            capacity: 33,
            is_active: true,
            created_at: '2026-08-06T00:00:00Z',
          },
        ],
      },
    });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/vehicle-types/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, business: undefined } },
      })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].name).toBe('33-seater coaster');
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
      '/api/v1/vehicle-types/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, business: 'biz-1' } },
      })
    );
  });
});
