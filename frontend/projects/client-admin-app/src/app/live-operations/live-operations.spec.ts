import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Poller } from '@shared-data';

import { LiveOperations } from './live-operations';
import { LiveOperationsStore, type TripLiveEnvelope } from '../shared/data/store/live-operations.store';

function envelope(overrides: Record<string, unknown> = {}): TripLiveEnvelope {
  return {
    trip: {
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
    },
    position: {
      latitude: '6.524400',
      longitude: '3.379200',
      recorded_at: '2026-09-07T07:10:00Z',
      source: 'device',
      staleness_seconds: 12,
    },
    progress: {
      last_stop: 'Ojota',
      next_stop: 'Maryland',
      stops_completed: 3,
      stops_total: 8,
      method: 'nearest_stop',
    },
    eta: {
      next_stop_at: '2026-09-07T07:20:00Z',
      final_stop_at: '2026-09-07T08:00:00Z',
      method: 'scheduled_segment',
      confidence: 'low',
    },
    punctuality: { delay_minutes: 4 },
    occupancy: { boarded: 20, capacity: 44 },
    incidents_open: 1,
    ...overrides,
  } as TripLiveEnvelope;
}

class FakeLiveOperationsStore {
  trips = signal<TripLiveEnvelope[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  pollError = signal<string | null>(null);
  isEmpty = signal(false);
  pollIntervalSeconds = signal(12);
  hasSimulatedData = signal(false);
  poll = jasmine.createSpy('poll').and.resolveTo();
}

describe('LiveOperations', () => {
  let fixture: ComponentFixture<LiveOperations>;
  let store: FakeLiveOperationsStore;

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function setup(): void {
    store = new FakeLiveOperationsStore();
    TestBed.configureTestingModule({
      imports: [LiveOperations],
      providers: [{ provide: LiveOperationsStore, useValue: store }],
    });
    fixture = TestBed.createComponent(LiveOperations);
  }

  afterEach(() => {
    fixture.destroy();
  });

  it('shows a loading skeleton while the first poll is outstanding', () => {
    setup();
    store.loading.set(true);
    fixture.detectChanges();

    expect(el().querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('shows an empty state once settled with no live trips', () => {
    setup();
    store.loading.set(false);
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(el().textContent).toContain('No trips in progress');
  });

  it('replaces the board with an alert on a load failure', () => {
    setup();
    store.loading.set(false);
    store.error.set('Failed to load live vehicle positions.');
    fixture.detectChanges();

    expect(el().textContent).toContain('Failed to load live vehicle positions.');
    expect(el().querySelector('[role="listitem"]')).toBeNull();
  });

  it('surfaces a poll failure without blanking a board that already has data', () => {
    setup();
    store.loading.set(false);
    store.trips.set([envelope()]);
    store.pollError.set('Timed out');
    fixture.detectChanges();

    expect(el().textContent).toContain('Timed out');
    expect(el().querySelector('[role="listitem"]')).not.toBeNull();
  });

  it('shows the mandatory simulated-data warning, and only when data is simulated', () => {
    setup();
    store.loading.set(false);
    store.trips.set([envelope()]);
    store.hasSimulatedData.set(false);
    fixture.detectChanges();
    expect(el().textContent).not.toContain('simulated');

    store.hasSimulatedData.set(true);
    fixture.detectChanges();
    expect(el().textContent).toContain('simulated positions');
  });

  it('lists every live trip and shows its detail on selection', () => {
    setup();
    store.loading.set(false);
    store.trips.set([envelope()]);
    fixture.detectChanges();

    const row = el().querySelector<HTMLButtonElement>('[role="listitem"]')!;
    expect(row.textContent).toContain('Ikeja → CMS');
    expect(row.textContent).toContain('LAG-221-XY');

    expect(el().textContent).toContain('Select a trip');

    row.click();
    fixture.detectChanges();

    expect(el().textContent).toContain('A. Bello');
    expect(el().textContent).toContain('3 / 8 stops');
    expect(el().textContent).toContain('20 / 44');
    expect(el().textContent).toContain('4 min late');
  });

  it('shows "No signal" for a trip with no position, and excludes it from the map', () => {
    setup();
    store.loading.set(false);
    store.trips.set([envelope({ id: 'trip-2', position: null, progress: null, eta: null })]);
    fixture.detectChanges();

    expect(el().querySelector('[role="listitem"]')!.textContent).toContain('No signal');

    // The real `ui-map` renders one accessible-table row per marker —
    // a position-less trip must not become an invented (0, 0) marker.
    const mapRows = el().querySelectorAll('table.sr-only tbody tr');
    expect(mapRows.length).toBe(0);
  });

  it('renders "Unknown" for a trip with no capacity, delay or ETA basis, never a zero', () => {
    setup();
    store.loading.set(false);
    store.trips.set([
      envelope({
        occupancy: { boarded: 0, capacity: null },
        punctuality: { delay_minutes: null },
        eta: null,
      }),
    ]);
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('[role="listitem"]')!.click();
    fixture.detectChanges();

    expect(el().textContent).toContain('No vehicle assigned');
    expect(el().textContent).not.toContain('0 / 44');
  });

  it('starts polling on init and stops for good on teardown', () => {
    spyOn(Poller.prototype, 'start').and.callThrough();
    spyOn(Poller.prototype, 'destroy').and.callThrough();
    setup();
    fixture.detectChanges();

    expect(Poller.prototype.start).toHaveBeenCalledTimes(1);

    fixture.destroy();
    expect(Poller.prototype.destroy).toHaveBeenCalledTimes(1);
  });
});
