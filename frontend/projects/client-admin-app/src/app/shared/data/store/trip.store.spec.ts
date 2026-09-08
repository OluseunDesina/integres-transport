import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { TripStore } from './trip.store';

function makeTrip(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trip-1',
    schedule: null,
    route: { id: 'route-1', name: 'Ikeja Express' },
    business: 'biz-1',
    service_date: '2026-09-01',
    scheduled_departure_at: '2026-09-01T06:30:00Z',
    status: 'scheduled',
    status_changed_at: null,
    // docs/specs/16-operational-analytics.md slice 1 — null
    // on every Trip that has not departed, which is most of them.
    actual_departure_at: null,
    actual_arrival_at: null,
    vehicle: null,
    driver: null,
    booking_mode: 'reservation',
    cancellation_reason: '',
    compliance_warnings: [],
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

describe('TripStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: TripStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(TripStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeTrip()] } });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/trips/',
      jasmine.objectContaining({
        params: {
          query: {
            limit: 25,
            offset: 0,
            business: undefined,
            route: undefined,
            schedule: undefined,
            service_date: undefined,
            status: undefined,
            search: undefined,
          },
        },
      })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].route.name).toBe('Ikeja Express');
    expect(store.total()).toBe(1);
  });

  it('surfaces the server error message on failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

    await store.getAll();

    expect(store.error()).toBe('Forbidden.');
    expect(store.items()).toEqual([]);
  });

  it('round-trips all five query filters via updateQuery()', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await store.updateQuery({
      business: 'biz-1',
      route: 'route-1',
      schedule: 'schedule-1',
      service_date: '2026-09-01',
      status: 'scheduled',
    });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/trips/',
      jasmine.objectContaining({
        params: {
          query: {
            limit: 25,
            offset: 0,
            business: 'biz-1',
            route: 'route-1',
            schedule: 'schedule-1',
            service_date: '2026-09-01',
            status: 'scheduled',
            search: undefined,
          },
        },
      })
    );
  });
});
