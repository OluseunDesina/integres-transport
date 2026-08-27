import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { BusinessSuperAdminStore } from './business-super-admin.store';

function makeBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-1',
    client: 'client-1',
    client_name: 'Acme Shuttle Co',
    name: 'Acme Shuttle Lagos',
    vertical: 'shuttle',
    currency: 'NGN',
    is_active: true,
    kyb_status: 'approved',
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

describe('BusinessSuperAdminStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: BusinessSuperAdminStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };
    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });
    store = TestBed.inject(BusinessSuperAdminStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeBusiness()] } });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/super-admin/businesses/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, search: undefined } },
      })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].client_name).toBe('Acme Shuttle Co');
    expect(store.total()).toBe(1);
  });

  it('surfaces the server error message on failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

    await store.getAll();

    expect(store.error()).toBe('Forbidden.');
    expect(store.items()).toEqual([]);
  });

  it('round-trips the search filter via updateQuery()', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await store.updateQuery({ search: 'Lagos' });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/super-admin/businesses/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, search: 'Lagos' } },
      })
    );
  });

  describe('findById()', () => {
    it('returns an already-loaded item with no extra request', async () => {
      apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeBusiness({ id: 'biz-1' })] } });
      await store.getAll();
      apiClient.GET.calls.reset();

      const found = await store.findById('biz-1');

      expect(found?.id).toBe('biz-1');
      expect(apiClient.GET).not.toHaveBeenCalled();
    });

    it('pages through the full list to find a match past the first page', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => makeBusiness({ id: `biz-${i}` }));
      const page2 = [makeBusiness({ id: 'biz-100' })];
      apiClient.GET.and.callFake(
        (_url: string, options: { params: { query: { offset: number } } }) => {
          const { offset } = options.params.query;
          return Promise.resolve({
            data: { count: 101, results: offset === 0 ? page1 : page2 },
          });
        }
      );

      const found = await store.findById('biz-100');

      expect(found?.id).toBe('biz-100');
      expect(apiClient.GET).toHaveBeenCalledTimes(2);
      // `search: undefined` is explicit now that the lookup runs through
      // `fetchPage` (via `ListStore.findByIdPaged`) rather than through a
      // hand-written request of its own — same unfiltered call on the
      // wire, since openapi-fetch drops undefined params. Sharing
      // `fetchPage` is the point: the lookup and the browse can no
      // longer drift apart.
      expect(apiClient.GET).toHaveBeenCalledWith(
        '/api/v1/super-admin/businesses/',
        jasmine.objectContaining({
          params: { query: { limit: 100, offset: 0, search: undefined } },
        })
      );
      expect(apiClient.GET).toHaveBeenCalledWith(
        '/api/v1/super-admin/businesses/',
        jasmine.objectContaining({
          params: { query: { limit: 100, offset: 100, search: undefined } },
        })
      );
    });

    it('returns null once pagination is exhausted with no match', async () => {
      apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeBusiness({ id: 'biz-1' })] } });

      const found = await store.findById('does-not-exist');

      expect(found).toBeNull();
    });
  });
});
