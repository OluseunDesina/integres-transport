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
    total_amount: '1500.00',
    currency: 'NGN',
    cancellation_reason: '',
    seats: [],
    created_at: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

describe('BookingStore (client-admin)', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: BookingStore;

  beforeEach(() => {
    apiClient = {
      GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 1, results: [makeBooking()] } }),
    };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(BookingStore);
  });

  it('reads the staff endpoint, not the passengers own history', async () => {
    await store.getAll();

    expect(apiClient.GET).toHaveBeenCalledWith('/api/v1/bookings/', jasmine.anything());
    expect(store.items().length).toBe(1);
    expect(store.total()).toBe(1);
  });

  it('passes trip and status filters through', async () => {
    await store.updateQuery({ trip: 'trip-1', status: 'cancelled' });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/bookings/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, trip: 'trip-1', status: 'cancelled' } },
      })
    );
  });

  it('surfaces the server error message on failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'You do not have permission.' } });

    await store.getAll();

    expect(store.error()).toBe('You do not have permission.');
  });
});
