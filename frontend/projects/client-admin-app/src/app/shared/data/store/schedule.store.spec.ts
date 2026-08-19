import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { ScheduleStore } from './schedule.store';

describe('ScheduleStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: ScheduleStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(ScheduleStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [
          {
            id: 'schedule-1',
            route: 'route-1',
            business: 'biz-1',
            days_of_week: [1, 3, 5],
            departure_time: '07:30:00',
            effective_from: '2026-01-01',
            effective_until: null,
            is_active: true,
            created_at: '2026-08-06T00:00:00Z',
          },
        ],
      },
    });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/schedules/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, business: undefined } },
      })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].days_of_week).toEqual([1, 3, 5]);
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
      '/api/v1/schedules/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, business: 'biz-1' } },
      })
    );
  });
});
