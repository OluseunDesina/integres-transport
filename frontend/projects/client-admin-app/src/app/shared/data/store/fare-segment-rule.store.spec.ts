import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { FareSegmentRuleStore } from './fare-segment-rule.store';

describe('FareSegmentRuleStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: FareSegmentRuleStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(FareSegmentRuleStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [
          {
            id: 'fare-seg-1',
            business: 'biz-1',
            route: 'route-1',
            from_stop: 'stop-1',
            to_stop: 'stop-2',
            amount: '300.00',
            effective_from: '2026-01-01T00:00:00Z',
            effective_to: null,
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      },
    });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/fare-segment-rules/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, business: undefined } },
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

  it('scopes the request to a Business via updateQuery()', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await store.updateQuery({ business: 'biz-1' });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/fare-segment-rules/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, business: 'biz-1' } },
      })
    );
  });
});
