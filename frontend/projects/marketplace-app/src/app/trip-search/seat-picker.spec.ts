import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';

import { SeatPicker } from './seat-picker';
import type { SeatPickerRequest } from '../shared/booking-draft';

const SEAT_PICKER_REQUEST: SeatPickerRequest = {
  tripId: 'trip-1',
  routeName: 'GUO Transport · Yaba to Ikeja',
  serviceDate: '2026-10-01',
  scheduledDepartureAt: '2026-10-01T08:00:00Z',
  fromStop: { id: 'stop-a', name: 'Yaba' },
  toStop: { id: 'stop-b', name: 'Ikeja' },
};

function makeAvailability(overrides: Record<string, unknown> = {}) {
  return {
    status: 'open',
    booking_mode: 'reservation',
    seat_selection_enabled: true,
    trip_class: 'standard',
    capacity_remaining: null,
    seats: [
      {
        seat: { id: 'seat-1', seat_number: '1A', row: null, column: null },
        is_available: true,
      },
      {
        seat: { id: 'seat-2', seat_number: '1B', row: null, column: null },
        is_available: true,
      },
    ],
    ...overrides,
  };
}

describe('SeatPicker', () => {
  let apiClient: { GET: jasmine.Spy };
  let authStore: AuthStore;
  let fixture: ComponentFixture<SeatPicker>;
  let component: SeatPicker;

  function setUpState(): void {
    history.replaceState(SEAT_PICKER_REQUEST, '');
  }

  async function createComponent(): Promise<void> {
    fixture = TestBed.createComponent(SeatPicker);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };
    apiClient.GET.and.callFake((path: string) =>
      path.includes('/availability/')
        ? Promise.resolve({ data: makeAvailability() })
        : Promise.resolve({ data: { amount: '750.00', currency: 'NGN' } })
    );

    TestBed.configureTestingModule({
      imports: [SeatPicker],
      providers: [provideRouter([]), { provide: API_CLIENT, useValue: apiClient }],
    });

    authStore = TestBed.inject(AuthStore);
  });

  it('adds a blank traveler form when a seat is selected, and drops it on deselection', async () => {
    setUpState();
    await createComponent();
    const seat = component['availability']()[0];

    component['toggleSeat'](seat);
    expect(component['travelerFor']('seat-1')).toEqual({
      title: '',
      firstName: '',
      lastName: '',
      phone: '',
      email: '',
      dateOfBirth: '',
      gender: '',
      nationality: '',
    });

    component['toggleSeat'](seat);
    expect(component['travelerFor']('seat-1').firstName).toBe('');
    expect(component['selectedSeatIds']().has('seat-1')).toBeFalse();
  });

  it('cannot continue until every selected seat has a complete traveler', async () => {
    setUpState();
    await createComponent();
    const seat = component['availability']()[0];
    component['toggleSeat'](seat);

    expect(component['canContinue']()).toBeFalse();

    component['setTravelerField']('seat-1', 'firstName', 'Ada');
    component['setTravelerField']('seat-1', 'lastName', 'Lovelace');
    component['setTravelerField']('seat-1', 'phone', '+2348000000000');
    expect(component['canContinue']()).toBeFalse();

    component['setTravelerField']('seat-1', 'email', 'ada@example.com');
    expect(component['canContinue']()).toBeTrue();
  });

  it('redirects to /login with the booking as pendingBooking state when signed out', async () => {
    setUpState();
    await createComponent();
    spyOn(authStore, 'isAuthenticated').and.returnValue(false);
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    const seat = component['availability']()[0];
    component['toggleSeat'](seat);
    component['setTravelerField']('seat-1', 'firstName', 'Ada');
    component['setTravelerField']('seat-1', 'lastName', 'Lovelace');
    component['setTravelerField']('seat-1', 'phone', '+2348000000000');
    component['setTravelerField']('seat-1', 'email', 'ada@example.com');

    await component['continueToConfirm']();

    expect(navigateSpy).toHaveBeenCalledWith(['/login'], {
      state: jasmine.objectContaining({
        pendingBooking: jasmine.objectContaining({
          kind: 'seats',
          seats: [{ id: 'seat-1', seatNumber: '1A' }],
          travelers: {
            'seat-1': jasmine.objectContaining({ firstName: 'Ada', lastName: 'Lovelace' }),
          },
        }),
      }),
    });
  });

  it('navigates straight to /book with the traveler attached when already signed in', async () => {
    setUpState();
    await createComponent();
    spyOn(authStore, 'isAuthenticated').and.returnValue(true);
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    const seat = component['availability']()[0];
    component['toggleSeat'](seat);
    component['setTravelerField']('seat-1', 'firstName', 'Ada');
    component['setTravelerField']('seat-1', 'lastName', 'Lovelace');
    component['setTravelerField']('seat-1', 'phone', '+2348000000000');
    component['setTravelerField']('seat-1', 'email', 'ada@example.com');

    await component['continueToConfirm']();

    expect(navigateSpy).toHaveBeenCalledWith(['/book'], {
      state: jasmine.objectContaining({
        kind: 'seats',
        travelers: {
          'seat-1': jasmine.objectContaining({ firstName: 'Ada' }),
        },
      }),
    });
  });
});
