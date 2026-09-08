import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { TripTrackingStore } from './trip-tracking.store';

function envelope(overrides: Record<string, unknown> = {}) {
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
    progress: null,
    eta: null,
    punctuality: { delay_minutes: 4 },
    occupancy: { boarded: 20, capacity: 44 },
    incidents_open: 0,
    ...overrides,
  };
}

function fakeResponse(status: number): Response {
  return { status } as Response;
}

describe('TripTrackingStore', () => {
  let api: { GET: jasmine.Spy };
  let store: TripTrackingStore;

  beforeEach(() => {
    api = { GET: jasmine.createSpy('GET') };
    TestBed.configureTestingModule({ providers: [{ provide: API_CLIENT, useValue: api }] });
    store = TestBed.inject(TripTrackingStore);
  });

  it('polls the trip id in the path', async () => {
    api.GET.and.resolveTo({ data: envelope(), response: fakeResponse(200) });

    await store.poll('trip-1');

    expect(api.GET).toHaveBeenCalledWith(
      '/api/v1/trips/{id}/live/',
      jasmine.objectContaining({ params: { path: { id: 'trip-1' } } })
    );
    expect(store.data()?.trip.id).toBe('trip-1');
    expect(store.loading()).toBeFalse();
  });

  it('reports not-found on a 404, distinct from an error', async () => {
    api.GET.and.resolveTo({ data: undefined, response: fakeResponse(404) });

    await store.poll('trip-1');

    expect(store.notFound()).toBeTrue();
    expect(store.error()).toBeNull();
    expect(store.data()).toBeNull();
  });

  it('reports an error and no data on a first-poll failure', async () => {
    api.GET.and.resolveTo({
      data: undefined,
      error: { detail: 'Server error' },
      response: fakeResponse(500),
    });

    await store.poll('trip-1');

    expect(store.error()).toBe('Server error');
    expect(store.data()).toBeNull();
  });

  it('keeps the last known position on a later poll failure', async () => {
    api.GET.and.resolveTo({ data: envelope(), response: fakeResponse(200) });
    await store.poll('trip-1');

    api.GET.and.resolveTo({
      data: undefined,
      error: { detail: 'Timed out' },
      response: fakeResponse(500),
    });
    await store.poll('trip-1');

    expect(store.error()).toBeNull();
    expect(store.pollError()).toBe('Timed out');
    expect(store.data()?.trip.id).toBe('trip-1');
  });
});
