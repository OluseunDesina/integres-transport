import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { PaymentIntentStore } from './payment-intent.store';

function makePaymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payment-1',
    booking: 'booking-1',
    business: 'biz-1',
    passenger: 'user-1',
    amount: '1500.00',
    currency: 'NGN',
    status: 'succeeded',
    psp_provider: 'paystack',
    psp_reference: 'ref-1',
    psp_authorization_url: '',
    succeeded_at: '2026-08-10T00:00:00Z',
    failed_at: null,
    requires_manual_refund: false,
    created_at: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

describe('PaymentIntentStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: PaymentIntentStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(PaymentIntentStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makePaymentIntent()] } });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/payments/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, business: undefined, status: undefined } },
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

  it('round-trips business and status filters via updateQuery()', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await store.updateQuery({ business: 'biz-1', status: 'failed' });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/payments/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, business: 'biz-1', status: 'failed' } },
      })
    );
  });
});
