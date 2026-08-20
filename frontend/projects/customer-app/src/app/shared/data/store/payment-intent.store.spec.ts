import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { PaymentIntentStore } from './payment-intent.store';

function makePaymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payment-1',
    booking: 'booking-1',
    business: 'biz-1',
    passenger: 'user-1',
    amount: '750.00',
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
      '/api/v1/payments/mine/',
      jasmine.objectContaining({ params: { query: { limit: 25, offset: 0 } } })
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

  it('pages through with an offset', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 30, results: [] } });

    await store.changePage(25);

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/payments/mine/',
      jasmine.objectContaining({ params: { query: { limit: 25, offset: 25 } } })
    );
  });
});
