import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { VehicleStore } from './vehicle.store';

describe('VehicleStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: VehicleStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(VehicleStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [
          {
            id: 'v-1',
            business: 'biz-1',
            vehicle_type: 'vt-1',
            registration_number: 'LAG-123-XY',
            insurance_expires_at: null,
            roadworthiness_expires_at: null,
            is_active: true,
            compliance_warnings: [],
            created_at: '2026-08-06T00:00:00Z',
          },
        ],
      },
    });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/vehicles/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, business: undefined } },
      })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].registration_number).toBe('LAG-123-XY');
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
      '/api/v1/vehicles/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, business: 'biz-1' } },
      })
    );
  });
});
