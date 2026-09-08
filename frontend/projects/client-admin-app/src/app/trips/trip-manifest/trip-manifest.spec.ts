import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { expectColumnVisibilityParity } from '@shared-ui';

import { TripManifest } from './trip-manifest';
import { ExportStore } from '../../shared/data/store/export.store';
import { ManifestStore, type ManifestRow } from '../../shared/data/store/manifest.store';

function trip(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trip-1',
    route: 'Ikeja → CMS',
    trip_class: 'standard',
    service_date: '2026-09-07',
    scheduled_departure_at: '2026-09-07T07:00:00Z',
    status: 'in_progress',
    booking_mode: 'reservation',
    fare_collection_mode: 'prepaid',
    vehicle: 'LAG-221-XY',
    driver: 'A. Bello',
    ...overrides,
  };
}

function prepaidRow(overrides: Record<string, unknown> = {}) {
  return {
    ticket_id: 'ticket-1',
    booking_id: 'booking-1',
    booking_reference: 'BKG-AB12CD',
    passenger_name: 'Ada Obi',
    seat_number: '12A',
    ticket_status: 'issued',
    booking_status: 'paid',
    fare: '1200.00',
    currency: 'NGN',
    boarded_at: null,
    is_cancelled: false,
    ...overrides,
  } as unknown as ManifestRow;
}

function journeyRow(overrides: Record<string, unknown> = {}) {
  return {
    journey_id: 'journey-1',
    passenger_name: 'Bola Ade',
    board_stop: 'Ikeja',
    alight_stop: 'CMS',
    journey_status: 'closed',
    fare: '300.00',
    currency: 'NGN',
    boarded_at: '2026-09-07T07:10:00Z',
    alighted_at: '2026-09-07T07:40:00Z',
    ...overrides,
  } as unknown as ManifestRow;
}

class FakeManifestStore {
  data = signal<Record<string, unknown> | null>(null);
  rows = signal<ManifestRow[]>([]);
  total = signal(0);
  page = signal({ limit: 50, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  notFound = signal(false);
  isEmpty = signal(false);
  includeCancelled = signal(false);
  load = jasmine.createSpy('load').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
  setIncludeCancelled = jasmine.createSpy('setIncludeCancelled').and.resolveTo();

  show(envelope: Record<string, unknown>, rows: ManifestRow[] = []): void {
    this.data.set(envelope);
    this.rows.set(rows);
    this.total.set(rows.length);
    this.isEmpty.set(rows.length === 0);
  }
}

class FakeExportStore {
  error = signal<string | null>(null);
  isPending = () => false;
  download = jasmine.createSpy('download').and.resolveTo();
}

describe('TripManifest', () => {
  let fixture: ComponentFixture<TripManifest>;
  let store: FakeManifestStore;
  let exports: FakeExportStore;

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  async function setup(): Promise<void> {
    store = new FakeManifestStore();
    exports = new FakeExportStore();

    await TestBed.configureTestingModule({
      imports: [TripManifest],
      providers: [
        provideRouter([]),
        { provide: ManifestStore, useValue: store },
        { provide: ExportStore, useValue: exports },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'trip-1' }) } },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TripManifest);
    fixture.detectChanges();
  }

  it('labels the vehicle and driver rather than dot-separating them', async () => {
    await setup();
    store.show({ trip: trip({ driver: null }), kind: 'prepaid', totals: null });
    fixture.detectChanges();

    // "E2E-3456-LA · Not recorded" gave no way to tell which of the two
    // was missing.
    expect(text()).toContain('Vehicle LAG-221-XY');
    expect(text()).toContain('No driver assigned');
  });

  it('loads the manifest for the trip in the URL', async () => {
    await setup();

    expect(store.load).toHaveBeenCalledWith('trip-1');
  });

  it('shows a skeleton before the first answer, not an empty bus', async () => {
    await setup();
    store.loading.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('ui-skeleton')).not.toBeNull();
    expect(text()).not.toContain('Nobody is booked');
  });

  it('distinguishes a deleted trip from a failure', async () => {
    await setup();
    store.notFound.set(true);
    fixture.detectChanges();
    expect(text()).toContain('Trip not found');

    store.notFound.set(false);
    store.error.set('Failed to load this trip’s manifest.');
    fixture.detectChanges();
    expect(text()).toContain('Failed to load');
    expect(text()).not.toContain('Trip not found');
  });

  describe('a prepaid trip', () => {
    it('lists each ticket with its seat, reference and statuses', async () => {
      await setup();
      store.show({ trip: trip(), kind: 'prepaid', totals: null }, [prepaidRow()]);
      fixture.detectChanges();

      expect(text()).toContain('Ada Obi');
      expect(text()).toContain('12A');
      expect(text()).toContain('BKG-AB12CD');
      // Both statuses carry a label, never colour alone.
      expect(text()).toContain('Issued');
      expect(text()).toContain('Paid');
    });

    it('says a held seat has no ticket yet rather than leaving the cell blank', async () => {
      await setup();
      store.show({ trip: trip(), kind: 'prepaid', totals: null }, [
        prepaidRow({ ticket_id: null, ticket_status: null, booking_status: 'pending_payment' }),
      ]);
      fixture.detectChanges();

      // A ticket is issued at payment, so an unpaid counter booking has
      // none — the ordinary outcome of selling at a desk, since the
      // ledger has no cash account. An empty cell would read as missing
      // data on the row an operator most needs to notice.
      expect(text()).toContain('Not issued');
      expect(fixture.componentInstance['ticketStatusTone'](null)).toBe('warning');
    });

    it('names an open-seating place rather than leaving the seat blank', async () => {
      await setup();
      store.show({ trip: trip(), kind: 'prepaid', totals: null }, [
        prepaidRow({ seat_number: null }),
      ]);
      fixture.detectChanges();

      expect(text()).toContain('Open seating');
    });

    it('states the cancelled-bookings narrowing rather than applying it silently', async () => {
      await setup();
      store.show({ trip: trip(), kind: 'prepaid', totals: null }, [prepaidRow()]);
      fixture.detectChanges();

      // A list quietly showing a subset is indistinguishable from a list
      // with less data.
      expect(text()).toContain('Cancelled and expired bookings are hidden');
      expect(text()).toContain('Unpaid holds are always shown');
    });

    it('asks the store to widen when the toggle is turned on', async () => {
      await setup();
      store.show({ trip: trip(), kind: 'prepaid', totals: null }, [prepaidRow()]);
      fixture.detectChanges();

      fixture.componentInstance['onIncludeCancelled'](true);

      expect(store.setIncludeCancelled).toHaveBeenCalledWith(true);
    });

    it('keeps every hidden column paired with its header', async () => {
      await setup();
      store.show({ trip: trip(), kind: 'prepaid', totals: null }, [prepaidRow()]);
      fixture.detectChanges();

      expectColumnVisibilityParity(fixture.nativeElement, 'trip-manifest (prepaid)');
    });
  });

  describe('a pay-as-you-go trip', () => {
    it('lists journeys rather than an empty booking list', async () => {
      await setup();
      store.show(
        { trip: trip({ fare_collection_mode: 'pay_as_you_go' }), kind: 'pay_as_you_go', totals: null },
        [journeyRow()]
      );
      fixture.detectChanges();

      // The whole reason the envelope carries a `kind`: such a trip
      // sells no bookings, so an empty list would say the bus is empty
      // when it is full.
      expect(text()).toContain('Bola Ade');
      expect(text()).toContain('Ikeja');
      expect(text()).toContain('Alighted');
      expect(text()).not.toContain('Reference');
    });

    it('says a passenger is still aboard rather than showing blanks', async () => {
      await setup();
      store.show({ trip: trip(), kind: 'pay_as_you_go', totals: null }, [
        journeyRow({ alight_stop: null, alighted_at: null, journey_status: 'open', fare: null }),
      ]);
      fixture.detectChanges();

      expect(text()).toContain('Still aboard');
      // A fare of 0.00 would be a claim that they rode for free.
      expect(text()).not.toContain('0.00');
    });

    it('offers no cancelled toggle, which would mean nothing here', async () => {
      await setup();
      store.show({ trip: trip(), kind: 'pay_as_you_go', totals: null }, [journeyRow()]);
      fixture.detectChanges();

      // A journey is opened by a tap and closed by another; it is not
      // cancellable.
      expect(text()).not.toContain('Show cancelled bookings');
    });

    it('keeps every hidden column paired with its header', async () => {
      await setup();
      store.show({ trip: trip(), kind: 'pay_as_you_go', totals: null }, [journeyRow()]);
      fixture.detectChanges();

      expectColumnVisibilityParity(fixture.nativeElement, 'trip-manifest (pay as you go)');
    });
  });

  describe('totals', () => {
    it('says no vehicle is assigned rather than reporting a capacity of zero', async () => {
      await setup();
      store.show({
        trip: trip({ vehicle: null }),
        kind: 'prepaid',
        totals: { passengers: 3, boarded: 1, capacity: null },
      });
      fixture.detectChanges();

      // Zero would tell an operator the bus is full.
      expect(text()).toContain('No vehicle assigned');
      expect(fixture.componentInstance['capacityLabel']()).toBe('No vehicle assigned');
    });

    it('renders a real capacity as a number', async () => {
      await setup();
      store.show({
        trip: trip(),
        kind: 'prepaid',
        totals: { passengers: 3, boarded: 1, capacity: 44 },
      });
      fixture.detectChanges();

      expect(fixture.componentInstance['capacityLabel']()).toBe('44');
    });
  });

  describe('empty states', () => {
    it('distinguishes an unbooked departure from one that sells no bookings', async () => {
      await setup();
      store.show({ trip: trip(), kind: 'prepaid', totals: null });
      fixture.detectChanges();
      expect(text()).toContain('Nobody is booked on this departure');

      store.show({ trip: trip(), kind: 'pay_as_you_go', totals: null });
      fixture.detectChanges();
      expect(text()).toContain('Nobody has tapped on yet');
      expect(text()).toContain('collects fares on board');
    });
  });

  it('exports through the typed client, naming this trip', async () => {
    await setup();
    store.show({ trip: trip(), kind: 'prepaid', totals: null }, [prepaidRow()]);
    fixture.detectChanges();

    await fixture.componentInstance['download']();

    // The `manifest` resource is bounded by a trip rather than a
    // period, so the trip has to travel with it.
    expect(exports.download).toHaveBeenCalledWith('manifest', { trip: 'trip-1' });
  });
});
