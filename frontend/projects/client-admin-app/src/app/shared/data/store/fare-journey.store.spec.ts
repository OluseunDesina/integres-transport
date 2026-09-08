import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { FareJourneyStore } from './fare-journey.store';

describe('FareJourneyStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: FareJourneyStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(FareJourneyStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [
          {
            id: 'journey-1',
            business: 'biz-1',
            trip: {
              id: 'trip-1',
              route: { id: 'route-1', name: 'Ikeja Express' },
              scheduled_departure_at: '2026-08-19T07:00:00Z',
              service_date: '2026-08-19',
            },
            passenger: 'user-1',
            status: 'closed',
            board_stop: 'Ikeja Bus Stop',
            alight_stop: 'Lekki Toll Gate',
            amount: '300.00',
            currency: 'NGN',
            boarded_at: '2026-08-19T07:05:00Z',
            alighted_at: '2026-08-19T07:35:00Z',
            created_at: '2026-08-19T07:05:00Z',
          },
        ],
      },
    });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/fare-journeys/',
      jasmine.objectContaining({
        params: {
          query: {
            limit: 25,
            offset: 0,
            business: undefined,
            status: undefined,
          },
        },
      })
    );
    expect(store.items().length).toBe(1);
    expect(store.total()).toBe(1);
  });

  it('surfaces the server error message on failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

    await store.getAll();

    expect(store.error()).toBe('Forbidden.');
    expect(store.items()).toEqual([]);
  });

  it('filters by status via updateQuery()', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await store.updateQuery({ status: 'needs_review' });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/fare-journeys/',
      jasmine.objectContaining({
        params: {
          query: {
            limit: 25,
            offset: 0,
            business: undefined,
            status: 'needs_review',
          },
        },
      })
    );
  });
});
