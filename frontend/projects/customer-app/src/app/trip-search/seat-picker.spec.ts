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
  // Deliberately disagrees with the envelope's `standard` in
  // `respondWith`, so a test that reads the carried state instead of
  // the freshly-fetched envelope fails — see the class-source test
  // below (docs/specs/15-trip-classes.md slice 3).
  tripClass: 'mini',
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

  /** Wraps `seats` in the availability envelope the endpoint returns as
   * of docs/specs/10-booking-modes.md. `status` is now load-bearing, so
   * it is stated explicitly per test rather than derived from the seat
   * list — deriving it would let a test pass against the very
   * conflation ("empty seats means sold out") this screen was fixed
   * for. */
  function respondWith(
    seats: unknown[],
    fare: unknown = { amount: '750.00', currency: 'NGN' },
    envelope: Record<string, unknown> = {}
  ) {
    const body = {
      booking_mode: 'reservation',
      trip_class: 'standard',
      status: seats.length === 0 ? 'not_configured' : 'open',
      seats,
      capacity_remaining: null,
      seat_selection_enabled: true,
      ...envelope,
    };
    apiClient.GET.and.callFake((path: string) =>
      path === '/api/v1/trips/{id}/availability/'
        ? Promise.resolve({ data: body })
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

    expect(
      component['seatRows']().map((r) => [
        r.row,
        r.segments.map((segment) => segment.map((s) => s.seat.seat_number)),
      ])
    ).toEqual([
      [1, [['1A', '1B']]],
      [2, [['2A']]],
    ]);
  });

  it('falls back to one flat row when no seat has geometry', async () => {
    await createComponent();

    expect(component['seatRows']().length).toBe(1);
    expect(component['seatRows']()[0].row).toBeNull();
  });

  /**
   * The flat fallback used to render whatever order the API sent.
   *
   * `apps.seating.services.get_availability` reads
   * `Seat.objects.filter(...)` with no `order_by`, so it inherits
   * `Seat.Meta.ordering = ["-created_at"]` and returns the seats newest
   * first — iteration-15 photographed a bus reading 3B, 3A, 2B, 2A, 1B,
   * 1A. The row/column path was never affected; it sorts itself.
   */
  it('sorts the flat fallback, because the response is newest-first', async () => {
    respondWith([
      makeSeat('seat-6', '3B', true),
      makeSeat('seat-5', '3A', true),
      makeSeat('seat-2', '1B', true),
      makeSeat('seat-1', '1A', true),
    ]);

    await createComponent();

    expect(component['seatRows']()[0].segments[0].map((s) => s.seat.seat_number)).toEqual([
      '1A',
      '1B',
      '3A',
      '3B',
    ]);
  });

  // A plain string sort puts 10A before 2A, which is the second way to
  // get a seat map wrong after not sorting it at all.
  it('orders seat 10 after seat 9, not after seat 1', async () => {
    respondWith([
      makeSeat('seat-10', '10A', true),
      makeSeat('seat-9', '9A', true),
      makeSeat('seat-2', '2A', true),
    ]);

    await createComponent();

    expect(component['seatRows']()[0].segments[0].map((s) => s.seat.seat_number)).toEqual([
      '2A',
      '9A',
      '10A',
    ]);
  });

  it('splits a row into segments at an aisle column gap', async () => {
    respondWith([
      makeSeat('seat-1', '1A', true, 1, 1),
      makeSeat('seat-2', '1B', true, 1, 2),
      makeSeat('seat-3', '1C', true, 1, 4),
      makeSeat('seat-4', '1D', true, 1, 5),
    ]);

    await createComponent();

    expect(
      component['seatRows']()[0].segments.map((segment) => segment.map((s) => s.seat.seat_number))
    ).toEqual([
      ['1A', '1B'],
      ['1C', '1D'],
    ]);
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

  // One test per `status`, in both modes — docs/specs/10-booking-modes.md's
  // own test plan. The two empty states below used to be the same
  // rendering, because both arrived as an empty seat array; a test that
  // only checked "no seat map is shown" would still pass against that
  // bug, so each asserts the *words* a passenger actually reads.
  describe('status', () => {
    it('says a vehicle-less departure is not open yet, not that it is full', async () => {
      respondWith([], undefined, { status: 'not_configured' });

      await createComponent();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Not open for booking yet');
      expect(text).not.toContain('full');
      expect(component['loadError']()).toBeNull();
    });

    it('says a genuinely full departure is full, not that it is unconfigured', async () => {
      respondWith([makeSeat('seat-1', '1A', false)], undefined, { status: 'sold_out' });

      await createComponent();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('This departure is full');
      expect(text).not.toContain('Not open for booking yet');
      // The seat map is not offered either — every seat is taken, so
      // there is nothing to choose from.
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[role="group"]')
      ).toBeNull();
    });

    it('renders the seat map when open', async () => {
      await createComponent();

      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[role="group"]')
      ).not.toBeNull();
    });

    it('distinguishes the two empty states for open seating too', async () => {
      respondWith([], undefined, {
        booking_mode: 'open_seating',
        status: 'sold_out',
        capacity_remaining: 0,
        seat_selection_enabled: false,
      });

      await createComponent();

      expect((fixture.nativeElement as HTMLElement).textContent).toContain(
        'This departure is full'
      );
    });
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
        // The envelope's class, not JOURNEY's own `mini`.
        tripClass: 'standard',
        kind: 'seats',
        seats: [{ id: 'seat-1', seatNumber: '1A' }],
        farePerSeat: '750.00',
        currency: 'NGN',
      },
    });
  });

  // --- service classes, docs/specs/15-trip-classes.md slice 3 ---------

  it('renders the class from the availability envelope, not from carried state', async () => {
    // JOURNEY carries `mini`; the envelope says `premium`. Only reading
    // the envelope can pass — which is the point, because router state
    // survives a refresh and can be arbitrarily stale, while the
    // envelope was fetched moments ago.
    respondWith([makeSeat('seat-1', '1A', true)], undefined, { trip_class: 'premium' });

    await createComponent();
    fixture.detectChanges();

    expect(component['serviceClass']()).toBe('Premium');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Premium service');
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Mini service');
  });

  it('hands the envelope’s class on to the confirm screen, overwriting the carried one', async () => {
    respondWith([makeSeat('seat-1', '1A', true)], undefined, { trip_class: 'premium' });
    await createComponent();
    component['toggleSeat'](makeSeat('seat-1', '1A', true) as never);

    await component['continueToConfirm']();

    const state = navigateSpy.calls.mostRecent().args[1].state;
    expect(state.tripClass).toBe('premium');
  });

  it('leaves no dangling separator when the envelope carries no class', async () => {
    respondWith([makeSeat('seat-1', '1A', true)], undefined, { trip_class: '' });

    await createComponent();

    expect(component['serviceClass']()).toBe('');
    expect(component['journeyLine']()).not.toContain('service');
    expect(component['journeyLine']()?.endsWith('·')).toBeFalse();
  });

  it('does not continue with nothing selected', async () => {
    await createComponent();

    await component['continueToConfirm']();

    expect(navigateSpy).not.toHaveBeenCalledWith(['/book'], jasmine.anything());
  });

  // The second way to buy — docs/specs/10-booking-modes.md. Open
  // seating has no seats at all; quick book has seats the operator
  // allocates. The screen treats them identically, because from a
  // passenger's side they are the same question.
  describe('when the passenger buys places rather than seats', () => {
    function openSeatingEnvelope(overrides: Record<string, unknown> = {}) {
      return {
        booking_mode: 'open_seating',
        status: 'open',
        capacity_remaining: 3,
        seat_selection_enabled: false,
        ...overrides,
      };
    }

    it('asks how many passengers instead of showing a seat map', async () => {
      respondWith([], undefined, openSeatingEnvelope());

      await createComponent();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('h1')?.textContent).toContain('How many passengers?');
      expect(host.querySelector('[role="group"]')).toBeNull();
      // A ui-select now, not a hand-rolled <select> with a fixed id —
      // the component generates its own, and the label is what a user
      // (and getByLabel) actually reaches it by.
      const label = host.querySelector('ui-select label');
      expect(label?.textContent?.trim()).toBe('Passengers');
      expect(host.querySelector(`#${label?.getAttribute('for')}`)?.tagName).toBe('SELECT');
    });

    it('offers no more places than are actually left', async () => {
      respondWith([], undefined, openSeatingEnvelope({ capacity_remaining: 2 }));

      await createComponent();

      expect(component['placeOptions']()).toEqual([1, 2]);
    });

    it('caps an unlimited departure rather than offering an unbounded list', async () => {
      respondWith([], undefined, openSeatingEnvelope({ capacity_remaining: null }));

      await createComponent();

      expect(component['placeOptions']().length).toBe(10);
    });

    it('prices from the passenger count and hands it to the confirm screen', async () => {
      respondWith([], undefined, openSeatingEnvelope());
      await createComponent();

      component['setPassengerCount']('3');

      expect(component['totalLabel']()).toBe('NGN 2250.00');

      await component['continueToConfirm']();

      expect(navigateSpy).toHaveBeenCalledWith(['/book'], {
        state: {
          ...JOURNEY,
          tripClass: 'standard',
          kind: 'places',
          passengerCount: 3,
          farePerSeat: '750.00',
          currency: 'NGN',
        },
      });
    });

    it('does not ask "how many" about a departure that cannot be booked', async () => {
      // Found in the §10.6 visual pass: "How many passengers?" sat
      // directly above "Not open for booking yet".
      respondWith([], undefined, openSeatingEnvelope({ status: 'not_configured' }));

      await createComponent();

      expect((fixture.nativeElement as HTMLElement).querySelector('h1')?.textContent).not.toContain(
        'How many'
      );
    });

    it('pluralises the passenger count', async () => {
      respondWith([], undefined, openSeatingEnvelope());
      await createComponent();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('1 passenger');
      expect(text).not.toContain('1 passengers');

      component['setPassengerCount']('2');
      fixture.detectChanges();

      expect((fixture.nativeElement as HTMLElement).textContent).toContain('2 passengers');
    });

    it('explains open seating and quick book differently', async () => {
      // Telling a quick-book passenger holding seat 3B to "sit anywhere
      // that's free" would be plainly wrong.
      respondWith([], undefined, openSeatingEnvelope());
      await createComponent();
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('sit anywhere');

      respondWith([makeSeat('seat-1', '1A', true)], undefined, {
        booking_mode: 'reservation',
        status: 'open',
        seat_selection_enabled: false,
      });
      await component['load']();
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('assigns seats for you');
      expect(text).not.toContain('sit anywhere');
    });

    it('asks the same question for a reservation trip whose operator assigns seats', async () => {
      // Quick book: there *are* seats, and the map is deliberately not
      // offered. Inferring the mode from an empty seat list would show
      // this passenger a seat map they are not allowed to use.
      respondWith([makeSeat('seat-1', '1A', true), makeSeat('seat-2', '1B', true)], undefined, {
        booking_mode: 'reservation',
        status: 'open',
        seat_selection_enabled: false,
      });

      await createComponent();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('h1')?.textContent).toContain('How many passengers?');
      expect(host.querySelector('[role="group"]')).toBeNull();
      // Bounded by the seats that are actually free, not by the
      // unlimited cap — the operator can only allocate what exists.
      expect(component['placeOptions']()).toEqual([1, 2]);
    });
  });
});
