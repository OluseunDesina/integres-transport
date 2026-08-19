import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import type { BookingRequest } from '../shared/booking-draft';
import { BookingConfirm } from './booking-confirm';

const REQUEST: BookingRequest = {
  tripId: 'trip-1',
  routeName: 'Ikeja → CMS',
  serviceDate: '2026-09-01',
  scheduledDepartureAt: '2026-09-01T06:30:00Z',
  fromStop: { id: 'stop-a', name: 'Ikeja' },
  toStop: { id: 'stop-c', name: 'CMS' },
  seats: [
    { id: 'seat-1', seatNumber: '1A' },
    { id: 'seat-2', seatNumber: '1B' },
  ],
  farePerSeat: '750.00',
  currency: 'NGN',
};

function makeBooking() {
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
  };
}

describe('BookingConfirm', () => {
  let apiClient: { POST: jasmine.Spy };
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
    apiClient = { POST: jasmine.createSpy('POST') };
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

  it('sends the passenger to my-bookings on success', async () => {
    await createComponent();

    await component['submit']();

    expect(navigateSpy).toHaveBeenCalledWith(['/my-bookings']);
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

  it('goes back to the seat map without a conflict notice', async () => {
    await createComponent();

    await component['backToSeats']();

    expect(navigateSpy).toHaveBeenCalledWith(['/search/seats'], {
      state: jasmine.objectContaining({ notice: undefined }),
    });
  });
});
