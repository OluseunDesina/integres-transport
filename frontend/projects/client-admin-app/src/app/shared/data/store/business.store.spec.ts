import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { BusinessStore, type Business } from './business.store';

interface Params {
  limit: number;
  offset: number;
}

function makeBusiness(id: string): Business {
  return {
    id,
    vertical: 'shuttle',
    name: `Business ${id}`,
    currency: 'NGN',
    timezone: 'Africa/Lagos',
    booking_mode_default: 'reservation',
    kyb_status: 'pending',
    kyb_submitted_at: null,
    created_at: '2026-08-06T00:00:00Z',
  } as Business;
}

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

  describe('findById', () => {
    /** `total` businesses named `biz-<n>`, served one 100-row page at a
     * time from the offset the caller asked for. */
    function stubList(total: number): void {
      apiClient.GET.and.callFake((_path: string, init: { params: { query: Params } }) => {
        const { limit, offset } = init.params.query;
        const results = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) =>
          makeBusiness(`biz-${offset + i}`)
        );
        return Promise.resolve({ data: { count: total, results } });
      });
    }

    it('resolves a business that lies past the browse page', async () => {
      // The whole point of this method. Both callers previously did one
      // bounded 25-row fetch and gave up, so index 25 onward silently
      // rendered "That business couldn't be found" — reproduced live
      // against 77 businesses during the spec-11 visual pass.
      stubList(77);

      const found = await store.findById('biz-40');

      expect(found?.id).toBe('biz-40');
    });

    it('returns null for an id that is in no page', async () => {
      stubList(77);

      expect(await store.findById('biz-999')).toBeNull();
    });

    it('costs one request when the list fits in a single lookup page', async () => {
      stubList(30);

      await store.findById('biz-29');

      expect(apiClient.GET).toHaveBeenCalledTimes(1);
    });

    it('never disturbs the browse state it is called alongside', async () => {
      // `business-list` may be paginated to something other than page 1;
      // a lookup from the edit or KYB screen must not reset it.
      stubList(200);
      await store.getAll();
      const browsed = store.items();

      await store.findById('biz-150');

      expect(store.items()).toBe(browsed);
      expect(store.total()).toBe(200);
    });
  });
});
