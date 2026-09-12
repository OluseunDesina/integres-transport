import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import type { BookingRequest } from '../shared/booking-draft';
import { BookingConfirm } from './booking-confirm';

const JOURNEY = {
  tripId: 'trip-1',
  routeName: 'Ikeja → CMS',
  serviceDate: '2026-09-01',
  scheduledDepartureAt: '2026-09-01T06:30:00Z',
  fromStop: { id: 'stop-a', name: 'Ikeja' },
  toStop: { id: 'stop-c', name: 'CMS' },
  tripClass: 'premium',
  farePerSeat: '750.00',
  currency: 'NGN',
};

const REQUEST: BookingRequest = {
  ...JOURNEY,
  kind: 'seats',
  seats: [
    { id: 'seat-1', seatNumber: '1A' },
    { id: 'seat-2', seatNumber: '1B' },
  ],
};

/** The other thing a passenger can buy — open seating, or reservation
 * mode with seat choice off (docs/specs/10-booking-modes.md). */
const PLACES_REQUEST: BookingRequest = {
  ...JOURNEY,
  kind: 'places',
  passengerCount: 2,
};

function makeBooking(
  overrides: { hold_expires_at?: string | null; hold_expires_in_seconds?: number | null } = {}
) {
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
    // Reservation-mode default — a real hold, the ordinary case for
    // REQUEST (kind: 'seats'). Tests for the places/open-seating case
    // override both to null explicitly.
    hold_expires_at: '2026-08-10T00:15:00Z',
    hold_expires_in_seconds: 900,
    created_at: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

describe('BookingConfirm', () => {
  let apiClient: { POST: jasmine.Spy; GET: jasmine.Spy };
  let fixture: ComponentFixture<BookingConfirm>;
  let component: BookingConfirm;
  let navigateSpy: jasmine.Spy;

  async function createComponent(state: BookingRequest | null = REQUEST): Promise<void> {
    const router = TestBed.inject(Router);
    navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);
    spyOn(router, 'getCurrentNavigation').and.returnValue(
      state ? ({ extras: { state } } as never) : null
    );

    fixture = TestBed.createComponent(BookingConfirm);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    apiClient = {
      POST: jasmine.createSpy('POST'),
      // BookingStore.findById (injected for the post-expiry re-fetch)
      // pages through GET /bookings/mine/ — unused by most tests here,
      // but must exist so injecting BookingConfirm doesn't throw.
      GET: jasmine.createSpy('GET').and.resolveTo({ data: { results: [], count: 0 } }),
    };
    apiClient.POST.and.resolveTo({ data: makeBooking(), response: { status: 201 } });

    TestBed.configureTestingModule({
      imports: [BookingConfirm],
      providers: [provideRouter([]), { provide: API_CLIENT, useValue: apiClient }],
    });
  });

  it('starts the flow over when there is no booking in navigation state', async () => {
    await createComponent(null);

    expect(navigateSpy).toHaveBeenCalledWith(['/search']);
  });

  it('shows the per-seat fare and an exact multi-seat total', async () => {
    await createComponent();

    expect(component['fareLabel']()).toBe('NGN 750.00');
    expect(component['totalLabel']()).toBe('NGN 1500.00');
    expect(component['seatNumbers']()).toBe('1A, 1B');
  });

  // --- service classes, docs/specs/15-trip-classes.md slice 3 ---------

  it('renders the service class in the review list', async () => {
    await createComponent();

    const host = fixture.nativeElement as HTMLElement;
    const terms = [...host.querySelectorAll('dt')].map((dt) => dt.textContent?.trim());
    expect(terms).toContain('Service');
    expect(host.querySelector('dl')?.textContent).toContain('Premium');
  });

  it('omits the Service row rather than rendering it blank', async () => {
    // A state object written by an older build carries no `tripClass`
    // (see booking-draft.ts). A "Service:" row with nothing after it
    // reads as a rendering fault.
    const withoutClass: Record<string, unknown> = { ...REQUEST };
    delete withoutClass['tripClass'];
    await createComponent(withoutClass as unknown as BookingRequest);

    // The guard must still accept it — `tripClass` is optional for
    // exactly this reason. If it were required the screen would bounce
    // to /search with a half-made booking behind it, which is a much
    // worse outcome than a missing label.
    expect(navigateSpy).not.toHaveBeenCalledWith(['/search']);
    const host = fixture.nativeElement as HTMLElement;
    const terms = [...host.querySelectorAll('dt')].map((dt) => dt.textContent?.trim());
    expect(terms).not.toContain('Service');
    expect(terms).toContain('Route');
  });

  it('carries the class back to the seat map, so Back does not lose it', async () => {
    await createComponent();

    await component['backToSeats']();

    expect(navigateSpy).toHaveBeenCalledWith(['/search/seats'], {
      state: jasmine.objectContaining({ tripClass: 'premium' }),
    });
  });

  it('posts the booking with an Idempotency-Key header', async () => {
    await createComponent();

    await component['submit']();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/bookings/',
      jasmine.objectContaining({
        params: { header: { 'Idempotency-Key': jasmine.any(String) } },
        body: {
          trip: 'trip-1',
          seats: [
            { seat: 'seat-1', from_stop: 'stop-a', to_stop: 'stop-c' },
            { seat: 'seat-2', from_stop: 'stop-a', to_stop: 'stop-c' },
          ],
        },
      })
    );
  });

  it('reuses the same Idempotency-Key across a retry, so a timeout cannot double-book', async () => {
    await createComponent();
    apiClient.POST.and.resolveTo({ error: { detail: 'Timed out.' }, response: { status: 504 } });

    await component['submit']();
    await component['submit']();

    const keys = apiClient.POST.calls
      .allArgs()
      .map((args) => (args[1] as { params: { header: Record<string, string> } }).params.header['Idempotency-Key']);
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('shows a held/confirmed panel on success instead of navigating away', async () => {
    await createComponent();

    await component['submit']();
    fixture.detectChanges();

    expect(navigateSpy).not.toHaveBeenCalledWith(['/my-bookings']);
    expect(component['createdBooking']()?.id).toBe('booking-1');
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Your seats are held');
    expect(text).toContain('Continue to My Bookings');
  });

  it('navigates to my-bookings only once the passenger presses Continue', async () => {
    await createComponent();
    await component['submit']();

    await component['continueToMyBookings']();

    expect(navigateSpy).toHaveBeenCalledWith(['/my-bookings']);
  });

  it('renders a live countdown from the created booking, with no second request', async () => {
    await createComponent();

    await component['submit']();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('ui-countdown')).not.toBeNull();
    expect(apiClient.GET).not.toHaveBeenCalled();
  });

  it('re-fetches the booking rather than asserting expiry once the countdown reaches zero', async () => {
    await createComponent();
    await component['submit']();
    fixture.detectChanges();

    apiClient.GET.and.resolveTo({
      data: {
        results: [makeBooking({ hold_expires_at: null, hold_expires_in_seconds: null })],
        count: 1,
      },
    });

    await component['onHoldExpired']();

    expect(apiClient.GET).toHaveBeenCalled();
    expect(component['createdBooking']()?.hold_expires_in_seconds).toBeNull();
  });

  describe('when the created booking holds nothing (open seating)', () => {
    it('renders no countdown and says the booking is confirmed once paid', async () => {
      apiClient.POST.and.resolveTo({
        data: makeBooking({ hold_expires_at: null, hold_expires_in_seconds: null }),
        response: { status: 201 },
      });
      await createComponent(PLACES_REQUEST);

      await component['submit']();
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('ui-countdown')?.textContent?.trim()).toBe('');
      expect(host.textContent).toContain('confirmed once you pay');
      expect(host.textContent).not.toContain('held');
    });
  });

  it('never offers a payment affordance — Phase 5 owns that', async () => {
    await createComponent();

    expect((fixture.nativeElement as HTMLElement).textContent?.toLowerCase()).not.toContain(
      'pay now'
    );
  });

  it('sends the passenger back to the seat map on a 409 seat conflict', async () => {
    await createComponent();
    apiClient.POST.and.resolveTo({
      error: { detail: 'Seat already taken.' },
      response: { status: 409 },
    });

    await component['submit']();

    expect(navigateSpy).toHaveBeenCalledWith(['/search/seats'], {
      state: jasmine.objectContaining({
        tripId: 'trip-1',
        notice: 'One of the seats you picked was taken while you were booking. Choose another.',
      }),
    });
    // A stale selection needs a fresh availability check, never a
    // blind resubmit — so the conflict must not surface as a retryable
    // inline error on this screen.
    expect(component['submitError']()).toBeNull();
  });

  it('surfaces a non-conflict failure inline and stays put', async () => {
    await createComponent();
    apiClient.POST.and.resolveTo({
      error: { detail: 'Trip is no longer scheduled.' },
      response: { status: 400 },
    });

    await component['submit']();

    expect(component['submitError']()).toBe('Trip is no longer scheduled.');
    expect(navigateSpy).not.toHaveBeenCalledWith(['/search/seats'], jasmine.anything());
  });

  describe('when the passenger bought places rather than seats', () => {
    it('posts passenger_count and the journey, not a seats array', async () => {
      await createComponent(PLACES_REQUEST);

      await component['submit']();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/bookings/',
        jasmine.objectContaining({
          body: {
            trip: 'trip-1',
            passenger_count: 2,
            from_stop: 'stop-a',
            to_stop: 'stop-c',
          },
        })
      );
    });

    it('prices the same way, from the passenger count', async () => {
      await createComponent(PLACES_REQUEST);

      expect(component['totalLabel']()).toBe('NGN 1500.00');
    });

    it('does not promise that places are held', async () => {
      // Found in the §10.6 visual pass. Open seating holds nothing at
      // all — a place is counted when a ticket is issued at payment —
      // so the reservation flow's "held once you reserve" copy would be
      // a plainly false statement here.
      await createComponent(PLACES_REQUEST);

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).not.toContain('held');
      expect(text).toContain('confirmed once you pay');
    });

    it('shows a passenger count instead of a blank seats row', async () => {
      await createComponent(PLACES_REQUEST);

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Passengers');
      expect(text).not.toContain('Seats');
      expect(component['seatNumbers']()).toBeNull();
    });
  });

  it('goes back to the seat map without a conflict notice', async () => {
    await createComponent();

    await component['backToSeats']();

    expect(navigateSpy).toHaveBeenCalledWith(['/search/seats'], {
      state: jasmine.objectContaining({ notice: undefined }),
    });
  });
});
