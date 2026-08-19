import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { BookingStore } from './booking.store';

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'booking-1',
    business: 'biz-1',
    trip: {
      id: 'trip-1',
      route: { id: 'route-1', name: 'Ikeja → CMS' },
      scheduled_departure_at: '2026-09-01T06:30:00Z',
      service_date: '2026-09-01',
    },
    passenger: 'user-1',
    status: 'pending_payment',
    total_amount: '750.00',
    currency: 'NGN',
    cancellation_reason: '',
    seats: [],
    created_at: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

describe('BookingStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: BookingStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(BookingStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeBooking()] } });

    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/bookings/mine/',
      jasmine.objectContaining({ params: { query: { limit: 25, offset: 0 } } })
    );
    expect(store.items().length).toBe(1);
    expect(store.items()[0].trip.route.name).toBe('Ikeja → CMS');
    expect(store.total()).toBe(1);
  });

  it('surfaces the server error message on failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

    await store.getAll();

    expect(store.error()).toBe('Forbidden.');
    expect(store.items()).toEqual([]);
  });

  it('sends no filter params — the server scopes to the caller', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await store.getAll();

    const [, options] = apiClient.GET.calls.mostRecent().args as [
      string,
      { params: { query: Record<string, unknown> } },
    ];
    expect(Object.keys(options.params.query).sort()).toEqual(['limit', 'offset']);
  });

  it('pages through with an offset', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 30, results: [] } });

    await store.changePage(25);

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/bookings/mine/',
      jasmine.objectContaining({ params: { query: { limit: 25, offset: 25 } } })
    );
  });
});
