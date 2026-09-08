import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { CounterBooking } from './counter-booking';
import {
  CounterBookingStore,
  type Passenger,
  type SeatAvailability,
  type StaffBooking,
  type TripBookability,
} from '../../shared/data/store/counter-booking.store';
import { RouteStore } from '../../shared/data/store/route.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { TripStore } from '../../shared/data/store/trip.store';

const PASSENGER: Passenger = {
  id: 'passenger-1',
  first_name: 'Ada',
  last_name: 'Obi',
  email: 'a••••••@example.com',
} as Passenger;

function seat(number: string): SeatAvailability {
  return {
    seat: { id: `seat-${number}`, seat_number: number },
    is_available: true,
  } as unknown as SeatAvailability;
}

function bookability(overrides: Partial<TripBookability> = {}): TripBookability {
  return {
    booking_mode: 'reservation',
    trip_class: 'standard',
    status: 'scheduled',
    seat_selection_enabled: true,
    capacity_remaining: 4,
    seats: [],
    ...overrides,
  } as TripBookability;
}

class FakeCounterBookingStore {
  passenger = signal<Passenger | null>(null);
  lookupError = signal<string | null>(null);
  lookingUp = signal(false);
  bookability = signal<TripBookability | null>(null);
  bookabilityError = signal<string | null>(null);
  loadingSeats = signal(false);
  result = signal<StaffBooking | null>(null);
  submitting = signal(false);
  availableSeats = signal<SeatAvailability[]>([]);

  lookup = jasmine.createSpy('lookup').and.resolveTo();
  clearPassenger = jasmine.createSpy('clearPassenger');
  loadBookability = jasmine.createSpy('loadBookability').and.resolveTo();
  clearBookability = jasmine.createSpy('clearBookability');
  resetBooking = jasmine.createSpy('resetBooking');
  book = jasmine.createSpy('book').and.resolveTo({ ok: true, error: null });
}

class FakeListStore {
  items = signal<unknown[]>([]);
  updateQuery = jasmine.createSpy('updateQuery').and.resolveTo();
  findById = jasmine.createSpy('findById').and.resolveTo(null);
}

const TRIP = {
  id: 'trip-1',
  route: { id: 'route-1', name: 'Ikeja → CMS' },
  scheduled_departure_at: '2026-09-09T07:00:00Z',
};

const ROUTE = {
  id: 'route-1',
  name: 'Ikeja → CMS',
  stops: [
    { id: 'stop-b', name: 'CMS', sequence: 2 },
    { id: 'stop-a', name: 'Ikeja', sequence: 1 },
  ],
};

describe('CounterBooking', () => {
  let fixture: ComponentFixture<CounterBooking>;
  let store: FakeCounterBookingStore;
  let trips: FakeListStore;
  let routes: FakeListStore;

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  async function setup(): Promise<void> {
    store = new FakeCounterBookingStore();
    trips = new FakeListStore();
    routes = new FakeListStore();

    await TestBed.configureTestingModule({
      imports: [CounterBooking],
      providers: [
        provideRouter([]),
        { provide: CounterBookingStore, useValue: store },
        { provide: TripStore, useValue: trips },
        { provide: RouteStore, useValue: routes },
        {
          provide: SelectedBusinessStore,
          useValue: { selectedBusinessId: signal<string | null>('biz-1') },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CounterBooking);
    fixture.detectChanges();
  }

  function resolvePassenger(): void {
    store.passenger.set(PASSENGER);
    fixture.detectChanges();
  }

  function pickSegment(): void {
    fixture.componentInstance['form'].patchValue({
      trip: 'trip-1',
      from_stop: 'stop-a',
      to_stop: 'stop-b',
    });
    fixture.detectChanges();
  }

  describe('finding the passenger first', () => {
    it('does not offer the booking form before anyone is resolved', async () => {
      await setup();

      // Everything after the lookup is wasted work if they have no
      // account — the endpoint books for an existing passenger only.
      expect(text()).not.toContain('Trip and stops');
      expect(text()).toContain('Find passenger');
    });

    it('will not look up an incomplete address, and says why on screen', async () => {
      await setup();
      fixture.componentInstance['lookupForm'].controls.email.setValue('ada');

      await fixture.componentInstance['onLookup']();
      fixture.detectChanges();

      expect(store.lookup).not.toHaveBeenCalled();
      expect(text()).toContain('Enter a complete email address.');
    });

    it('shows an unregistered passenger as information, not as an error', async () => {
      await setup();
      store.lookupError.set('No passenger account uses that email address. They need to register…');
      fixture.detectChanges();

      expect(text()).toContain('need to register');
      // Not in the alert component, which is reserved for failures.
      expect(fixture.nativeElement.querySelector('ui-alert')).toBeNull();
    });

    it('shows the resolved passenger by name, with the address still masked', async () => {
      await setup();
      resolvePassenger();

      expect(text()).toContain('Ada Obi');
      expect(text()).toContain('a••••••@example.com');
      expect(text()).toContain('Trip and stops');
    });

    it('says an account has no name rather than showing a blank line', async () => {
      await setup();
      store.passenger.set({ ...PASSENGER, first_name: '', last_name: '' } as Passenger);
      fixture.detectChanges();

      // An empty line above the address reads as a failed lookup on the
      // one card whose whole job is confirming a person.
      expect(text()).toContain('No name on this account');
    });

    it('lets the agent switch to the next person in the queue', async () => {
      await setup();
      resolvePassenger();

      fixture.componentInstance['onChangePassenger']();

      expect(store.clearPassenger).toHaveBeenCalled();
    });
  });

  describe('the departure and its stops', () => {
    it('asks the server for the trips of one service date', async () => {
      await setup();

      expect(trips.updateQuery).toHaveBeenCalledWith(
        jasmine.objectContaining({ business: 'biz-1', status: 'scheduled' })
      );
    });

    it('resolves the route by id rather than looking for it in a page', async () => {
      await setup();
      routes.findById.and.resolveTo(ROUTE);
      trips.items.set([TRIP]);
      resolvePassenger();
      fixture.componentInstance['form'].patchValue({ trip: 'trip-1' });
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      // A Business with more than one page of routes would not find its
      // own with `items().find(...)`, and the stop pickers would sit
      // empty saying nothing.
      expect(routes.findById).toHaveBeenCalledWith('route-1');
      expect(fixture.componentInstance['stopOptions']().map((option) => option.label)).toEqual([
        'Choose a stop',
        'Ikeja',
        'CMS',
      ]);
    });
  });

  describe('choosing places', () => {
    it('offers the free seats when the trip lets a passenger choose one', async () => {
      await setup();
      resolvePassenger();
      pickSegment();
      store.bookability.set(bookability());
      store.availableSeats.set([seat('1A'), seat('1B')]);
      fixture.detectChanges();

      expect(text()).toContain('1A');
      expect(text()).toContain('Choose seats');
      expect(text()).not.toContain('How many passengers');
    });

    it('asks for a number of places when the operator sells places', async () => {
      await setup();
      resolvePassenger();
      pickSegment();
      store.bookability.set(bookability({ seat_selection_enabled: false }));
      fixture.detectChanges();

      expect(text()).toContain('How many passengers');
      expect(text()).not.toContain('Choose seats');
    });

    it('bounds the places on offer by what is actually left', async () => {
      await setup();
      store.bookability.set(bookability({ seat_selection_enabled: false, capacity_remaining: 3 }));
      fixture.detectChanges();

      expect(fixture.componentInstance['placeOptions']().map((o) => o.value)).toEqual([
        '1',
        '2',
        '3',
      ]);
    });

    it('caps an uncapped trip rather than offering an unbounded number', async () => {
      await setup();
      store.bookability.set(
        bookability({ seat_selection_enabled: false, capacity_remaining: null })
      );
      fixture.detectChanges();

      // A free-text number field is an invitation to a typo that books
      // forty seats.
      expect(fixture.componentInstance['placeOptions']().length).toBe(10);
    });

    it('says "not capped" rather than a zero when capacity is unlimited', async () => {
      await setup();
      store.bookability.set(bookability({ capacity_remaining: null }));
      fixture.detectChanges();

      // A 0 would stop an agent selling a seat that exists.
      expect(fixture.componentInstance['capacityLabel']()).toBe('Not capped');
    });

    it('says every seat is taken rather than showing an empty row of chips', async () => {
      await setup();
      resolvePassenger();
      pickSegment();
      store.bookability.set(bookability());
      store.availableSeats.set([]);
      fixture.detectChanges();

      expect(text()).toContain('Every seat on this segment is taken');
    });
  });

  describe('booking', () => {
    async function readyToBook(): Promise<void> {
      await setup();
      resolvePassenger();
      pickSegment();
      store.bookability.set(bookability());
      store.availableSeats.set([seat('1A')]);
      fixture.detectChanges();
    }

    it('sends the chosen seats with the segment they were chosen for', async () => {
      await readyToBook();
      fixture.componentInstance['toggleSeat']('seat-1A');

      await fixture.componentInstance['onSubmit']();

      expect(store.book).toHaveBeenCalled();
      const [request] = store.book.calls.mostRecent().args;
      expect(request.seats).toEqual([
        { seat: 'seat-1A', from_stop: 'stop-a', to_stop: 'stop-b' },
      ]);
      expect(request.passenger).toBe('passenger-1');
    });

    it('reuses one idempotency key across a retry of the same booking', async () => {
      await readyToBook();
      fixture.componentInstance['toggleSeat']('seat-1A');
      store.book.and.resolveTo({ ok: false, error: { detail: 'Network trouble.' } });

      await fixture.componentInstance['onSubmit']();
      await fixture.componentInstance['onSubmit']();

      // Regenerating it is how a timeout that actually reached the
      // server becomes two held seats.
      const [first, second] = store.book.calls.all().map((call) => call.args[1]);
      expect(first).toBe(second);
    });

    it('takes a new key once a booking has actually been made', async () => {
      await readyToBook();
      fixture.componentInstance['toggleSeat']('seat-1A');

      await fixture.componentInstance['onSubmit']();
      await fixture.componentInstance['onSubmit']();

      const [first, second] = store.book.calls.all().map((call) => call.args[1]);
      expect(first).not.toBe(second);
    });

    it('says which seat was refused rather than only that something failed', async () => {
      await readyToBook();
      fixture.componentInstance['toggleSeat']('seat-1A');
      store.book.and.resolveTo({ ok: false, error: { seats: ['That seat has just been taken.'] } });

      await fixture.componentInstance['onSubmit']();
      fixture.detectChanges();

      // `seats` renders no control, so its error has to reach the
      // page-level alert or vanish entirely.
      expect(text()).toContain('That seat has just been taken.');
    });

    it('will not submit with no seat chosen, and says so on screen', async () => {
      await readyToBook();

      await fixture.componentInstance['onSubmit']();
      fixture.detectChanges();

      expect(store.book).not.toHaveBeenCalled();
      expect(text()).toContain('Choose at least one seat.');
    });
  });

  describe('the outcome', () => {
    function showResult(
      status: string,
      payment: { status: string; reason: string }
    ): void {
      store.result.set({
        booking: {
          id: 'booking-1',
          reference: 'BKG-AB12CD',
          status,
          total_amount: '1200.00',
          currency: 'NGN',
          trip: { route: { name: 'Ikeja → CMS' } },
        },
        payment,
      } as unknown as StaffBooking);
      fixture.detectChanges();
    }

    it('shows the reference the agent reads out loud', async () => {
      await setup();
      showResult('pending_payment', { status: 'not_attempted', reason: '' });

      expect(text()).toContain('BKG-AB12CD');
    });

    it('states that nothing was charged when the wallet was not used', async () => {
      await setup();
      showResult('pending_payment', { status: 'not_attempted', reason: '' });

      expect(text()).toContain('Nothing has been charged');
      expect(text()).toContain('Awaiting payment');
    });

    it('renders a failed wallet payment inline, not only as a toast', async () => {
      await setup();
      showResult('pending_payment', {
        status: 'failed',
        reason: 'The passenger’s wallet balance is not enough. The seats are held.',
      });

      // A booking that succeeded while its payment failed is the one
      // outcome an agent must not miss, and a toast is gone in four
      // seconds.
      expect(fixture.nativeElement.querySelector('ui-alert')).not.toBeNull();
      expect(text()).toContain('seats are held');
    });

    it('confirms a wallet payment that went through', async () => {
      await setup();
      showResult('paid', { status: 'succeeded', reason: '' });

      expect(text()).toContain('Paid from the passenger’s wallet.');
      expect(text()).toContain('Paid');
    });
  });
});
