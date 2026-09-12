import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { KybQueueStore } from './kyb-queue.store';

describe('KybQueueStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: KybQueueStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };
    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });
    store = TestBed.inject(KybQueueStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [
          {
            id: 'biz-1',
            client: 'client-1',
            client_name: 'Acme Shuttle Co',
            vertical: 'shuttle',
            name: 'Acme Shuttle Lagos',
            kyb_status: 'submitted',
            kyb_submitted_at: '2026-08-06T00:00:00Z',
            documents: [],
          },
        ],
      },
    });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/super-admin/kyb-queue/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, search: undefined } },
      })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].client_name).toBe('Acme Shuttle Co');
    expect(store.total()).toBe(1);
  });

  it('forwards a search term to the query params', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await store.updateQuery({ search: 'lagos' });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/super-admin/kyb-queue/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, search: 'lagos' } },
      })
    );
  });

  it('surfaces the server error message on failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

    await store.getAll();

    expect(store.error()).toBe('Forbidden.');
    expect(store.items()).toEqual([]);
  });
});
