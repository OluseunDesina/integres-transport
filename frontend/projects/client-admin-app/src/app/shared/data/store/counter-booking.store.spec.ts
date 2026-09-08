import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { CounterBookingStore } from './counter-booking.store';

function passenger(overrides: Record<string, unknown> = {}) {
  return {
    id: 'passenger-1',
    first_name: 'Ada',
    last_name: 'Obi',
    email: 'a••••••@example.com',
    ...overrides,
  };
}

function seat(number: string, isAvailable = true) {
  return { seat: { id: `seat-${number}`, seat_number: number }, is_available: isAvailable };
}

describe('CounterBookingStore', () => {
  let api: { GET: jasmine.Spy; POST: jasmine.Spy };
  let store: CounterBookingStore;

  beforeEach(() => {
    api = {
      GET: jasmine.createSpy('GET').and.resolveTo({ data: passenger() }),
      POST: jasmine.createSpy('POST').and.resolveTo({ data: { booking: {}, payment: {} } }),
    };
    TestBed.configureTestingModule({ providers: [{ provide: API_CLIENT, useValue: api }] });
    store = TestBed.inject(CounterBookingStore);
  });

  describe('looking a passenger up', () => {
    it('resolves one passenger by exact email', async () => {
      await store.lookup('ada.obi@example.com');

      expect(api.GET).toHaveBeenCalledWith('/api/v1/passengers/lookup/', {
        params: { query: { email: 'ada.obi@example.com' } },
      });
      expect(store.passenger()?.id).toBe('passenger-1');
      expect(store.lookupError()).toBeNull();
    });

    it('says a 404 is an unregistered person, not a failure', async () => {
      api.GET.and.resolveTo({ data: undefined, error: {}, response: { status: 404 } });

      await store.lookup('nobody@example.com');

      // The wording matters as much as the state: an agent reading
      // "something went wrong" gives up, and an agent reading "they
      // need to register" says the useful thing to the person in front
      // of them.
      expect(store.lookupError()).toContain('register');
      expect(store.passenger()).toBeNull();
    });

    it('distinguishes a server failure from an unknown address', async () => {
      api.GET.and.resolveTo({
        data: undefined,
        error: { detail: 'Service unavailable.' },
        response: { status: 503 },
      });

      await store.lookup('ada.obi@example.com');

      expect(store.lookupError()).toBe('Service unavailable.');
      expect(store.lookupError()).not.toContain('register');
    });

    it('forgets the passenger when the agent serves someone else', async () => {
      await store.lookup('ada.obi@example.com');

      store.clearPassenger();

      // A stale name beside a new booking is how the wrong person gets
      // charged.
      expect(store.passenger()).toBeNull();
    });
  });

  describe('availability', () => {
    it('offers free seats only, in the order a person reads them', async () => {
      api.GET.and.resolveTo({
        data: {
          booking_mode: 'reservation',
          trip_class: 'standard',
          status: 'scheduled',
          seat_selection_enabled: true,
          capacity_remaining: 3,
          seats: [seat('10A'), seat('2A'), seat('1A', false), seat('1B')],
        },
      });

      await store.loadBookability('trip-1', 'stop-a', 'stop-b');

      // 10A after 2A — a plain string sort is the second-most-common way
      // to render a seat list wrongly.
      expect(store.availableSeats().map((entry) => entry.seat.seat_number)).toEqual([
        '1B',
        '2A',
        '10A',
      ]);
    });

    it('reports a failure to load availability separately from a lookup one', async () => {
      api.GET.and.resolveTo({ data: undefined, error: { detail: 'Nope.' } });

      await store.loadBookability('trip-1', 'stop-a', 'stop-b');

      expect(store.bookabilityError()).toBe('Nope.');
      expect(store.lookupError()).toBeNull();
    });
  });

  describe('booking', () => {
    it('sends the idempotency key it was given, not one of its own', async () => {
      await store.book(
        { trip: 'trip-1', passenger: 'passenger-1', passenger_count: 2, pay_from_wallet: false },
        'key-1'
      );

      expect(api.POST).toHaveBeenCalledWith(
        '/api/v1/bookings/staff/',
        jasmine.objectContaining({ params: { header: { 'Idempotency-Key': 'key-1' } } })
      );
    });

    it('hands the raw error body back rather than a flattened message', async () => {
      const error = { seats: ['That seat is taken.'], trip: ['Not open for booking.'] };
      api.POST.and.resolveTo({ data: undefined, error });

      const result = await store.book(
        { trip: 'trip-1', passenger: 'passenger-1', pay_from_wallet: false },
        'key-1'
      );

      // The screen needs to know *which field* each complaint belongs
      // to; a first-message-wins string would discard the rest.
      expect(result.ok).toBeFalse();
      expect(result.error).toBe(error);
      expect(store.submitting()).toBeFalse();
    });

    it('keeps the resolved passenger when the booking is reset', async () => {
      await store.lookup('ada.obi@example.com');
      await store.book({ trip: 't', passenger: 'p', pay_from_wallet: false }, 'key-1');

      store.resetBooking();

      // Booking a second leg should not mean typing the address again.
      expect(store.passenger()?.id).toBe('passenger-1');
      expect(store.result()).toBeNull();
    });
  });
});
