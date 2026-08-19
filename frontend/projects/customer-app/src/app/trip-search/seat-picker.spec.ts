import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import type { SeatPickerRequest } from '../shared/booking-draft';
import { SeatPicker } from './seat-picker';

const JOURNEY: SeatPickerRequest = {
  tripId: 'trip-1',
  routeName: 'Ikeja → CMS',
  serviceDate: '2026-09-01',
  scheduledDepartureAt: '2026-09-01T06:30:00Z',
  fromStop: { id: 'stop-a', name: 'Ikeja' },
  toStop: { id: 'stop-c', name: 'CMS' },
};

function makeSeat(
  id: string,
  seatNumber: string,
  isAvailable: boolean,
  row: number | null = null,
  column: number | null = null
) {
  return {
    seat: {
      id,
      vehicle_type: 'vt-1',
      seat_number: seatNumber,
      row,
      column,
      is_active: true,
      created_at: '2026-08-01T00:00:00Z',
    },
    is_available: isAvailable,
  };
}

describe('SeatPicker', () => {
  let apiClient: { GET: jasmine.Spy };
  let fixture: ComponentFixture<SeatPicker>;
  let component: SeatPicker;
  let navigateSpy: jasmine.Spy;

  function respondWith(seats: unknown[], fare: unknown = { amount: '750.00', currency: 'NGN' }) {
    apiClient.GET.and.callFake((path: string) =>
      path === '/api/v1/trips/{id}/availability/'
        ? Promise.resolve({ data: seats })
        : Promise.resolve(fare ? { data: fare } : { error: { detail: 'No fare configured.' } })
    );
  }

  async function createComponent(state: SeatPickerRequest | null = JOURNEY): Promise<void> {
    const router = TestBed.inject(Router);
    navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);
    spyOn(router, 'getCurrentNavigation').and.returnValue(
      state ? ({ extras: { state } } as never) : null
    );

    fixture = TestBed.createComponent(SeatPicker);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };
    respondWith([makeSeat('seat-1', '1A', true), makeSeat('seat-2', '1B', false)]);

    TestBed.configureTestingModule({
      imports: [SeatPicker],
      providers: [provideRouter([]), { provide: API_CLIENT, useValue: apiClient }],
    });
  });

  it('starts the flow over when there is no journey in navigation state', async () => {
    await createComponent(null);

    expect(navigateSpy).toHaveBeenCalledWith(['/search']);
    expect(apiClient.GET).not.toHaveBeenCalled();
  });

  it('fetches availability and fare for the selected segment', async () => {
    await createComponent();

    const expected = jasmine.objectContaining({
      params: {
        path: { id: 'trip-1' },
        query: { from_stop: 'stop-a', to_stop: 'stop-c' },
      },
    });
    expect(apiClient.GET).toHaveBeenCalledWith('/api/v1/trips/{id}/availability/', expected);
    expect(apiClient.GET).toHaveBeenCalledWith('/api/v1/trips/{id}/fare/', expected);
  });

  it('renders available seats as selectable and unavailable ones as disabled', async () => {
    await createComponent();

    const buttons = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        '[role="group"] button'
      )
    );
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['1A', '1B']);
    expect(buttons[0].disabled).toBeFalse();
    expect(buttons[1].disabled).toBeTrue();
    expect(buttons[1].getAttribute('aria-label')).toBe('Seat 1B, unavailable');
  });

  it('groups seats into rows when the vehicle type defines geometry', async () => {
    respondWith([
      makeSeat('seat-3', '2A', true, 2, 1),
      makeSeat('seat-1', '1A', true, 1, 1),
      makeSeat('seat-2', '1B', true, 1, 2),
    ]);

    await createComponent();

    expect(component['seatRows']().map((r) => [r.row, r.seats.map((s) => s.seat.seat_number)])).toEqual(
      [
        [1, ['1A', '1B']],
        [2, ['2A']],
      ]
    );
  });

  it('falls back to one flat row when no seat has geometry', async () => {
    await createComponent();

    expect(component['seatRows']().length).toBe(1);
    expect(component['seatRows']()[0].row).toBeNull();
  });

  it('tracks a running total across multiple selected seats', async () => {
    respondWith([makeSeat('seat-1', '1A', true), makeSeat('seat-2', '1B', true)]);
    await createComponent();

    component['toggleSeat'](makeSeat('seat-1', '1A', true) as never);
    expect(component['totalLabel']()).toBe('NGN 750.00');

    component['toggleSeat'](makeSeat('seat-2', '1B', true) as never);
    expect(component['selectedCount']()).toBe(2);
    expect(component['totalLabel']()).toBe('NGN 1500.00');

    component['toggleSeat'](makeSeat('seat-1', '1A', true) as never);
    expect(component['selectedCount']()).toBe(1);
    expect(component['totalLabel']()).toBe('NGN 750.00');
  });

  it('ignores a click on an unavailable seat', async () => {
    await createComponent();

    component['toggleSeat'](makeSeat('seat-2', '1B', false) as never);

    expect(component['selectedCount']()).toBe(0);
  });

  it('shows an empty state when the trip has no vehicle assigned yet', async () => {
    respondWith([]);

    await createComponent();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('ui-empty-state')?.textContent).toContain(
      'Seating not yet configured'
    );
    expect(component['loadError']()).toBeNull();
  });

  it('blocks booking with an alert when the segment has no fare', async () => {
    respondWith([makeSeat('seat-1', '1A', true)], null);

    await createComponent();

    expect(component['fareError']()).toBe('No fare configured.');
    component['toggleSeat'](makeSeat('seat-1', '1A', true) as never);
    expect(component['selectedCount']()).toBe(0);
    expect(component['canContinue']()).toBeFalse();
  });

  it('surfaces a conflict notice handed back by the confirm screen', async () => {
    await createComponent({ ...JOURNEY, notice: 'That seat was just taken.' });

    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'That seat was just taken.'
    );
  });

  it('passes the selected seats and fare on to the confirm screen', async () => {
    respondWith([makeSeat('seat-1', '1A', true), makeSeat('seat-2', '1B', true)]);
    await createComponent();
    component['toggleSeat'](makeSeat('seat-1', '1A', true) as never);

    await component['continueToConfirm']();

    expect(navigateSpy).toHaveBeenCalledWith(['/book'], {
      state: {
        ...JOURNEY,
        seats: [{ id: 'seat-1', seatNumber: '1A' }],
        farePerSeat: '750.00',
        currency: 'NGN',
      },
    });
  });

  it('does not continue with nothing selected', async () => {
    await createComponent();

    await component['continueToConfirm']();

    expect(navigateSpy).not.toHaveBeenCalledWith(['/book'], jasmine.anything());
  });
});
