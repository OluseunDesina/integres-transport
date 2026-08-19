import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { KycQueueStore } from './kyc-queue.store';

describe('KycQueueStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: KycQueueStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };
    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });
    store = TestBed.inject(KycQueueStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [
          {
            id: 'client-1',
            name: 'Acme Shuttle Co',
            email: 'owner@example.com',
            phone: '',
            kyc_status: 'submitted',
            kyc_submitted_at: '2026-08-06T00:00:00Z',
            documents: [],
          },
        ],
      },
    });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/super-admin/kyc-queue/',
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
