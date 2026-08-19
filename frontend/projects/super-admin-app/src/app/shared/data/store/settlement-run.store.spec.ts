import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { SettlementRunStore } from './settlement-run.store';

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    business: 'biz-1',
    period_start: '2026-08-01',
    period_end: '2026-08-08',
    status: 'paid_out',
    initiated_by: 'staff-1',
    total_amount: '475.00',
    currency: 'NGN',
    psp_transfer_reference: 'TRF_abc123',
    psp_transfer_status: 'success',
    executed_at: '2026-08-08T00:00:00Z',
    created_at: '2026-08-08T00:00:00Z',
    ...overrides,
  };
}

describe('SettlementRunStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: SettlementRunStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };
    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });
    store = TestBed.inject(SettlementRunStore);
  });

  it('does not call the API when no business is set yet', async () => {
    await store.getAll();

    expect(apiClient.GET).not.toHaveBeenCalled();
    expect(store.items()).toEqual([]);
    expect(store.error()).toBeNull();
  });

  it('maps a {count,results} envelope to {items,total} once scoped to a business', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeRun()] } });

    await store.updateQuery({ business: 'biz-1' });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/settlement-runs/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, business: 'biz-1' } },
      })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].total_amount).toBe('475.00');
  });

  it('surfaces the server error message on failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

    await store.updateQuery({ business: 'biz-1' });

    expect(store.error()).toBe('Forbidden.');
    expect(store.items()).toEqual([]);
  });
});
