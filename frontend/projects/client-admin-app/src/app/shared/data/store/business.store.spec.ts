import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { BusinessStore } from './business.store';

describe('BusinessStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: BusinessStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(BusinessStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [
          {
            id: 'biz-1',
            vertical: 'shuttle',
            name: 'Acme Shuttle Co',
            currency: 'NGN',
            timezone: 'Africa/Lagos',
            booking_mode_default: 'reservation',
            kyb_status: 'pending',
            kyb_submitted_at: null,
            created_at: '2026-08-06T00:00:00Z',
          },
        ],
      },
    });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/businesses/',
      jasmine.objectContaining({ params: { query: { limit: 25, offset: 0 } } })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].name).toBe('Acme Shuttle Co');
    expect(store.total()).toBe(1);
  });

  it('surfaces the server error message on failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

    await store.getAll();

    expect(store.error()).toBe('Forbidden.');
    expect(store.items()).toEqual([]);
  });
});
