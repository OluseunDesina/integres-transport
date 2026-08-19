import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { TapCredentialStore } from './tap-credential.store';

function makeCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-1',
    channel: 'qr',
    label: 'My phone',
    is_active: true,
    created_at: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

describe('TapCredentialStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: TapCredentialStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(TapCredentialStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeCredential()] } });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/tap-credentials/mine/',
      jasmine.objectContaining({ params: { query: { limit: 25, offset: 0 } } })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].label).toBe('My phone');
    expect(store.total()).toBe(1);
  });

  it('surfaces the server error message on failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

    await store.getAll();

    expect(store.error()).toBe('Forbidden.');
    expect(store.items()).toEqual([]);
  });

  it('pages through with an offset', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 30, results: [] } });

    await store.changePage(25);

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/tap-credentials/mine/',
      jasmine.objectContaining({ params: { query: { limit: 25, offset: 25 } } })
    );
  });
});
