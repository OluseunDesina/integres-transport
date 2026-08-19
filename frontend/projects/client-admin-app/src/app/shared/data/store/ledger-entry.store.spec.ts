import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { LedgerEntryStore } from './ledger-entry.store';

function makeJournalEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    business: 'biz-1',
    entry_type: 'payment',
    external_reference: 'ref-1',
    memo: '',
    settlement_run: null,
    lines: [
      { id: 'line-1', account: 'acct-clearing', amount: '1500.00', currency: 'NGN' },
      { id: 'line-2', account: 'acct-commission', amount: '-1500.00', currency: 'NGN' },
    ],
    created_at: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

describe('LedgerEntryStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: LedgerEntryStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(LedgerEntryStore);
  });

  // `business` is a required backend query param, unlike PaymentIntentStore's
  // optional one — fetchPage must not call the API at all before a
  // Business is known, matching the guard the store's own doc-comment
  // describes.
  it('does not call the API when no business is set yet', async () => {
    await store.getAll();

    expect(apiClient.GET).not.toHaveBeenCalled();
    expect(store.items()).toEqual([]);
    expect(store.error()).toBeNull();
  });

  it('maps a {count,results} envelope to {items,total} once scoped to a business', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeJournalEntry()] } });

    await store.updateQuery({ business: 'biz-1' });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/ledger/entries/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, business: 'biz-1', account: undefined } },
      })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].lines.length).toBe(2);
  });

  it('round-trips the account filter via updateQuery()', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await store.updateQuery({ business: 'biz-1' });
    await store.updateQuery({ account: 'acct-clearing' });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/ledger/entries/',
      jasmine.objectContaining({
        params: {
          query: { limit: 25, offset: 0, business: 'biz-1', account: 'acct-clearing' },
        },
      })
    );
  });

  it('surfaces the server error message on failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

    await store.updateQuery({ business: 'biz-1' });

    expect(store.error()).toBe('Forbidden.');
    expect(store.items()).toEqual([]);
  });
});
