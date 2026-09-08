import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { Poller } from '@shared-data';

import { TripTracking } from './trip-tracking';
import { TripTrackingStore, type TripLiveEnvelope } from '../shared/data/store/trip-tracking.store';

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
    incidents_open: 0,
    ...overrides,
  } as TripLiveEnvelope;
}

class FakeTripTrackingStore {
  data = signal<TripLiveEnvelope | null>(null);
  loading = signal(true);
  notFound = signal(false);
  error = signal<string | null>(null);
  pollError = signal<string | null>(null);
  pollIntervalSeconds = signal(15);
  poll = jasmine.createSpy('poll').and.resolveTo();
}

describe('TripTracking', () => {
  let fixture: ComponentFixture<TripTracking>;
  let store: FakeTripTrackingStore;

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function setup(): void {
    store = new FakeTripTrackingStore();
    TestBed.configureTestingModule({
      imports: [TripTracking],
      providers: [
        { provide: TripTrackingStore, useValue: store },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'trip-1' }) } },
        },
      ],
    });
    fixture = TestBed.createComponent(TripTracking);
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

  it('shows a not-found state distinct from an error', () => {
    setup();
    store.loading.set(false);
    store.notFound.set(true);
    fixture.detectChanges();

    expect(el().textContent).toContain('Trip not found');
  });

  it('shows the route, vehicle, staleness and progress once loaded', () => {
    setup();
    store.loading.set(false);
    store.data.set(envelope());
    fixture.detectChanges();

    expect(el().textContent).toContain('Ikeja → CMS');
    expect(el().textContent).toContain('LAG-221-XY');
    expect(el().textContent).toContain('12s ago');
    expect(el().textContent).toContain('3 / 8 stops');
  });

  it('shows "No signal yet" and excludes the vehicle from the map with no position', () => {
    setup();
    store.loading.set(false);
    store.data.set(envelope({ position: null, progress: null, eta: null }));
    fixture.detectChanges();

    expect(el().textContent).toContain('No signal yet');
    const mapRows = el().querySelectorAll('table.sr-only tbody tr');
    expect(mapRows.length).toBe(0);
  });

  it('shows the mandatory simulated-data warning when the position is simulated', () => {
    setup();
    store.loading.set(false);
    store.data.set(
      envelope({ position: { ...envelope().position, source: 'simulated' } })
    );
    fixture.detectChanges();

    expect(el().textContent).toContain('simulated');
  });

  it('surfaces a poll failure without blanking a position already shown', () => {
    setup();
    store.loading.set(false);
    store.data.set(envelope());
    store.pollError.set('Timed out');
    fixture.detectChanges();

    expect(el().textContent).toContain('Timed out');
    expect(el().textContent).toContain('Ikeja → CMS');
  });

  it('starts polling the trip id on init and stops for good on teardown', () => {
    spyOn(Poller.prototype, 'start').and.callThrough();
    spyOn(Poller.prototype, 'destroy').and.callThrough();
    setup();
    fixture.detectChanges();

    expect(Poller.prototype.start).toHaveBeenCalledTimes(1);

    fixture.destroy();
    expect(Poller.prototype.destroy).toHaveBeenCalledTimes(1);
  });
});
