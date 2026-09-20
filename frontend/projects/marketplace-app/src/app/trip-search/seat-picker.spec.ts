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
    capacity_remaining: 4,
    seats: [],
    ...overrides,
  };
}

function fillTraveler(component: SeatPicker, index: number, first: string): void {
  component['setTravelerField'](index, 'firstName', first);
  component['setTravelerField'](index, 'lastName', 'Lovelace');
  component['setTravelerField'](index, 'phone', '+2348000000000');
  component['setTravelerField'](index, 'email', 'ada@example.com');
}

describe('SeatPicker', () => {
  let apiClient: { GET: jasmine.Spy };
  let authStore: AuthStore;
  let fixture: ComponentFixture<SeatPicker>;
  let component: SeatPicker;

  function setUpState(): void {
    history.replaceState(SEAT_PICKER_REQUEST, '');
  }

  function mockAvailability(overrides: Record<string, unknown> = {}): void {
    apiClient.GET.and.callFake((path: string) =>
      path.includes('/availability/')
        ? Promise.resolve({ data: makeAvailability(overrides) })
        : Promise.resolve({ data: { amount: '750.00', currency: 'NGN' } })
    );
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
    mockAvailability();

    TestBed.configureTestingModule({
      imports: [SeatPicker],
      providers: [provideRouter([]), { provide: API_CLIENT, useValue: apiClient }],
    });

    authStore = TestBed.inject(AuthStore);
  });

  it('starts with one passenger and one blank traveler form', async () => {
    setUpState();
    await createComponent();

    expect(component['passengerCount']()).toBe(1);
    expect(component['travelerFor'](0)).toEqual({
      title: '',
      firstName: '',
      lastName: '',
      phone: '',
      email: '',
      dateOfBirth: '',
      gender: '',
      nationality: '',
    });
  });

  it('growing the passenger count adds blank forms without touching existing ones', async () => {
    setUpState();
    await createComponent();
    fillTraveler(component, 0, 'Ada');

    component['setPassengerCount']('2');

    expect(component['travelerFor'](0).firstName).toBe('Ada');
    expect(component['travelerFor'](1).firstName).toBe('');
  });

  it('shrinking and regrowing the count keeps what was already typed', async () => {
    setUpState();
    await createComponent();
    component['setPassengerCount']('2');
    fillTraveler(component, 0, 'Ada');
    fillTraveler(component, 1, 'Grace');

    component['setPassengerCount']('1');
    component['setPassengerCount']('2');

    expect(component['travelerFor'](0).firstName).toBe('Ada');
    expect(component['travelerFor'](1).firstName).toBe('Grace');
  });

  it('cannot continue until every passenger up to the count has a complete traveler', async () => {
    setUpState();
    await createComponent();
    component['setPassengerCount']('2');
    fillTraveler(component, 0, 'Ada');

    expect(component['canContinue']()).toBeFalse();

    fillTraveler(component, 1, 'Grace');
    expect(component['canContinue']()).toBeTrue();
  });

  it('redirects to /login with the booking as pendingBooking state when signed out', async () => {
    setUpState();
    await createComponent();
    spyOn(authStore, 'isAuthenticated').and.returnValue(false);
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    fillTraveler(component, 0, 'Ada');

    await component['continueToConfirm']();

    expect(navigateSpy).toHaveBeenCalledWith(['/login'], {
      state: jasmine.objectContaining({
        pendingBooking: jasmine.objectContaining({
          passengerCount: 1,
          seatSelectionEnabled: true,
          travelers: [jasmine.objectContaining({ firstName: 'Ada', lastName: 'Lovelace' })],
        }),
      }),
    });
  });

  it('navigates straight to /book with the travelers attached when already signed in', async () => {
    setUpState();
    await createComponent();
    spyOn(authStore, 'isAuthenticated').and.returnValue(true);
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    fillTraveler(component, 0, 'Ada');

    await component['continueToConfirm']();

    expect(navigateSpy).toHaveBeenCalledWith(['/book'], {
      state: jasmine.objectContaining({
        passengerCount: 1,
        travelers: [jasmine.objectContaining({ firstName: 'Ada' })],
      }),
    });
  });

  it('never asks for a specific seat, even when the operator allows choosing one', async () => {
    setUpState();
    mockAvailability({ seat_selection_enabled: true });
    await createComponent();

    expect(fixture.nativeElement.textContent).toContain('How many passengers?');
    expect(fixture.nativeElement.querySelector('[aria-label="Seat map"]')).toBeNull();
  });

  it('hints that seats are unassigned on an open-seating trip', async () => {
    setUpState();
    mockAvailability({ booking_mode: 'open_seating', seat_selection_enabled: false });
    await createComponent();

    expect(fixture.nativeElement.textContent).toContain("sit anywhere that's free");
  });

  it('hints that a chosen seat can be changed later when the operator allows it', async () => {
    setUpState();
    mockAvailability({ seat_selection_enabled: true });
    await createComponent();

    expect(fixture.nativeElement.textContent).toContain('you can change them after booking');
  });

  it('hints that the operator assigns seats with no changing on true quick-book', async () => {
    setUpState();
    mockAvailability({ seat_selection_enabled: false });
    await createComponent();

    expect(fixture.nativeElement.textContent).toContain('This operator assigns seats for you');
  });
});
