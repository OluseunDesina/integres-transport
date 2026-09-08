import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { StaffStore } from './staff.store';

describe('StaffStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: StaffStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(StaffStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [
          {
            id: 'user-1',
            email: 'owner@example.com',
            first_name: '',
            last_name: '',
            role: { id: 'role-1', name: 'Owner', permissions: [] },
            is_active: true,
          },
        ],
      },
    });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/staff/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, search: undefined } },
      })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].email).toBe('owner@example.com');
    expect(store.total()).toBe(1);
  });

  it('surfaces the server error message on failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

    await store.getAll();

    expect(store.error()).toBe('Forbidden.');
    expect(store.items()).toEqual([]);
  });
});
