import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { BookingConfirm } from './booking-confirm';
import type { BookingRequest } from '../shared/booking-draft';
import { BookingStore, type Booking } from '../shared/data/store/booking.store';

const REQUEST: BookingRequest = {
  tripId: 'trip-1',
  routeName: 'GUO Transport · Yaba to Ikeja',
  serviceDate: '2026-10-01',
  scheduledDepartureAt: '2026-10-01T08:00:00Z',
  fromStop: { id: 'stop-a', name: 'Yaba' },
  toStop: { id: 'stop-b', name: 'Ikeja' },
  farePerSeat: '750.00',
  currency: 'NGN',
  passengerCount: 1,
  seatSelectionEnabled: true,
  travelers: [
    {
      title: '',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '+2348000000000',
      email: 'ada@example.com',
      dateOfBirth: '',
      gender: '',
      nationality: '',
    },
  ],
};

function makeBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'booking-1',
    reference: 'BKG-00001',
    business: 'biz-1',
    business_name: 'GUO Transport',
    trip: {
      id: 'trip-1',
      route: { id: 'route-1', name: 'Yaba → Ikeja' },
      scheduled_departure_at: '2026-10-01T08:00:00Z',
      service_date: '2026-10-01',
      trip_class: 'standard',
    },
    passenger: 'passenger-1',
    status: 'pending_payment',
    total_amount: '750.00',
    currency: 'NGN',
    cancellation_reason: '',
    seats: [
      {
        id: 'reservation-1',
        seat: '1A',
        from_stop: 'Yaba',
        to_stop: 'Ikeja',
        status: 'held',
        held_until: '2026-10-01T08:15:00Z',
        amount: '750.00',
        traveler: {
          id: 'traveler-1',
          title: '',
          first_name: 'Ada',
          last_name: 'Lovelace',
          phone: '+2348000000000',
          email: 'ada@example.com',
          date_of_birth: null,
          gender: '',
          nationality: '',
        },
      },
    ],
    travelers: [],
    hold_expires_at: '2026-10-01T08:15:00Z',
    hold_expires_in_seconds: 900,
    created_at: '2026-10-01T07:45:00Z',
    ...overrides,
  } as Booking;
}

describe('BookingConfirm', () => {
  let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy };
  let bookingStore: jasmine.SpyObj<BookingStore>;
  let fixture: ComponentFixture<BookingConfirm>;
  let component: BookingConfirm;

  function setUpState(): void {
    history.replaceState(REQUEST, '');
  }

  async function createComponent(): Promise<void> {
    fixture = TestBed.createComponent(BookingConfirm);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET'), POST: jasmine.createSpy('POST') };
    bookingStore = jasmine.createSpyObj<BookingStore>('BookingStore', ['findById']);

    TestBed.configureTestingModule({
      imports: [BookingConfirm],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: apiClient },
        { provide: BookingStore, useValue: bookingStore },
      ],
    });
  });

  it('submits passenger_count and travelers, never explicit seats', async () => {
    setUpState();
    apiClient.POST.and.resolveTo({ data: makeBooking() });
    await createComponent();

    await component['submit']();

    const [path, options] = apiClient.POST.calls.mostRecent().args;
    expect(path).toBe('/api/v1/marketplace/bookings/');
    expect(options.body).toEqual({
      trip: 'trip-1',
      passenger_count: 1,
      from_stop: 'stop-a',
      to_stop: 'stop-b',
      travelers: [
        {
          first_name: 'Ada',
          last_name: 'Lovelace',
          phone: '+2348000000000',
          email: 'ada@example.com',
        },
      ],
    });
  });

  it('shows the auto-assigned seat and its traveler once created', async () => {
    setUpState();
    apiClient.POST.and.resolveTo({ data: makeBooking() });
    await createComponent();

    await component['submit']();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Seat 1A');
    expect(text).toContain('Ada Lovelace');
  });

  it('shows named travelers instead of seats for an open-seating booking', async () => {
    setUpState();
    apiClient.POST.and.resolveTo({
      data: makeBooking({
        seats: [],
        travelers: [
          {
            id: 'traveler-1',
            title: '',
            first_name: 'Grace',
            last_name: 'Hopper',
            phone: '+2348111111111',
            email: 'grace@example.com',
            date_of_birth: null,
            gender: '',
            nationality: '',
          },
        ],
        hold_expires_in_seconds: null,
      }),
    });
    await createComponent();

    await component['submit']();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Grace Hopper');
    expect(text).not.toContain('Your seats are held');
  });

  it('does not offer "Change seat" on a true quick-book trip', async () => {
    history.replaceState({ ...REQUEST, seatSelectionEnabled: false }, '');
    apiClient.POST.and.resolveTo({ data: makeBooking() });
    await createComponent();

    await component['submit']();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Change seat');
  });

  it('offers "Change seat" and swaps to the chosen seat', async () => {
    setUpState();
    apiClient.POST.and.resolveTo({ data: makeBooking() });
    apiClient.GET.and.resolveTo({
      data: {
        status: 'open',
        booking_mode: 'reservation',
        seat_selection_enabled: true,
        trip_class: 'standard',
        capacity_remaining: 1,
        seats: [
          { seat: { id: 'seat-1', seat_number: '1A', row: null, column: null }, is_available: false },
          { seat: { id: 'seat-2', seat_number: '1B', row: null, column: null }, is_available: true },
        ],
      },
    });
    await createComponent();
    await component['submit']();
    fixture.detectChanges();

    await component['openChangeSeat']('reservation-1', '1A');
    fixture.detectChanges();

    expect(component['changeSeatOptions']()?.map((o) => o.seat.seat_number)).toEqual(['1B']);

    apiClient.POST.and.resolveTo({ data: makeBooking({ seats: [] }) });
    await component['chooseNewSeat']('reservation-1', 'seat-2');

    const [path, options] = apiClient.POST.calls.mostRecent().args;
    expect(path).toBe('/api/v1/marketplace/bookings/{id}/reservations/{reservation_pk}/change-seat/');
    expect(options.params.path).toEqual({ id: 'booking-1', reservation_pk: 'reservation-1' });
    expect(options.body).toEqual({ seat: 'seat-2' });
    expect(component['changingSeatFor']()).toBeNull();
  });

  it('returns to the passenger-count screen when the trip fills up mid-submit', async () => {
    setUpState();
    apiClient.POST.and.resolveTo({ error: { detail: 'Sold out' }, response: { status: 409 } });
    await createComponent();
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

    await component['submit']();

    expect(navigateSpy).toHaveBeenCalledWith(
      ['/search/seats'],
      jasmine.objectContaining({
        state: jasmine.objectContaining({ notice: jasmine.stringMatching(/filled up/) }),
      })
    );
  });
});
