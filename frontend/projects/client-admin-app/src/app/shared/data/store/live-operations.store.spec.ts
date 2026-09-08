import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { LiveOperationsStore, type TripLiveEnvelope } from './live-operations.store';

function envelope(id: string, overrides: Record<string, unknown> = {}): TripLiveEnvelope {
  return {
    trip: {
      id,
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

function fakeResponse(status: number, headers: Record<string, string> = {}): Response {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
  } as unknown as Response;
}

describe('LiveOperationsStore', () => {
  let api: { GET: jasmine.Spy };
  let store: LiveOperationsStore;

  beforeEach(() => {
    api = { GET: jasmine.createSpy('GET') };
    TestBed.configureTestingModule({ providers: [{ provide: API_CLIENT, useValue: api }] });
    store = TestBed.inject(LiveOperationsStore);
  });

  it('polls with no since and no If-None-Match on the very first request', async () => {
    api.GET.and.resolveTo({
      data: { results: [envelope('trip-1')], poll_interval_seconds: 12, server_time: 'T1' },
      response: fakeResponse(200, { etag: 'W/"a"' }),
    });

    await store.poll();

    expect(api.GET).toHaveBeenCalledWith(
      '/api/v1/trips/live/',
      jasmine.objectContaining({ params: { query: undefined }, headers: undefined })
    );
    expect(store.trips().map((t) => t.trip.id)).toEqual(['trip-1']);
    expect(store.loading()).toBeFalse();
    expect(store.pollIntervalSeconds()).toBe(12);
  });

  it('sends the previous etag and since on the next poll', async () => {
    api.GET.and.resolveTo({
      data: { results: [envelope('trip-1')], poll_interval_seconds: 12, server_time: 'T1' },
      response: fakeResponse(200, { etag: 'W/"a"' }),
    });
    await store.poll();

    api.GET.and.resolveTo({
      data: { results: [], poll_interval_seconds: 12, server_time: 'T2' },
      response: fakeResponse(200, { etag: 'W/"b"' }),
    });
    await store.poll();

    expect(api.GET).toHaveBeenCalledWith(
      '/api/v1/trips/live/',
      jasmine.objectContaining({
        params: { query: { since: 'T1' } },
        headers: { 'If-None-Match': 'W/"a"' },
      })
    );
  });

  it('leaves the board untouched on a 304', async () => {
    api.GET.and.resolveTo({
      data: { results: [envelope('trip-1')], poll_interval_seconds: 12, server_time: 'T1' },
      response: fakeResponse(200, { etag: 'W/"a"' }),
    });
    await store.poll();

    api.GET.and.resolveTo({ data: undefined, response: fakeResponse(304) });
    await store.poll();

    expect(store.trips().map((t) => t.trip.id)).toEqual(['trip-1']);

    // `since` was not advanced, so the next request still carries the
    // last value that actually reflected a change.
    api.GET.and.resolveTo({
      data: { results: [], poll_interval_seconds: 12, server_time: 'T2' },
      response: fakeResponse(200, { etag: 'W/"a"' }),
    });
    await store.poll();
    expect(api.GET.calls.mostRecent().args[1].params.query).toEqual({ since: 'T1' });
  });

  it('merges a delta response into the existing board rather than replacing it', async () => {
    api.GET.and.resolveTo({
      data: {
        results: [envelope('trip-1'), envelope('trip-2')],
        poll_interval_seconds: 12,
        server_time: 'T1',
      },
      response: fakeResponse(200, { etag: 'W/"a"' }),
    });
    await store.poll();

    // Only trip-1 moved — a delta response names just that row.
    api.GET.and.resolveTo({
      data: {
        results: [envelope('trip-1', { punctuality: { delay_minutes: 9 } })],
        poll_interval_seconds: 12,
        server_time: 'T2',
      },
      response: fakeResponse(200, { etag: 'W/"b"' }),
    });
    await store.poll();

    const ids = store.trips().map((t) => t.trip.id);
    expect(ids).toEqual(['trip-1', 'trip-2']);
    expect(store.trips().find((t) => t.trip.id === 'trip-1')?.punctuality.delay_minutes).toBe(9);
  });

  it('drops a completed trip only on the periodic full reconciliation poll', async () => {
    api.GET.and.resolveTo({
      data: {
        results: [envelope('trip-1'), envelope('trip-2')],
        poll_interval_seconds: 12,
        server_time: 'T0',
      },
      response: fakeResponse(200, { etag: 'W/"a"' }),
    });
    await store.poll(); // full poll #1 (the very first)

    // Six delta polls, none mentioning trip-2 — it does not disappear
    // from a delta response merging into the map.
    for (let i = 1; i <= 6; i++) {
      api.GET.and.resolveTo({
        data: { results: [envelope('trip-1')], poll_interval_seconds: 12, server_time: `T${i}` },
        response: fakeResponse(200, { etag: `W/"${i}"` }),
      });
      await store.poll();
    }
    expect(store.trips().map((t) => t.trip.id)).toEqual(['trip-1', 'trip-2']);

    // The 7th poll since the last full one reconciles from scratch —
    // trip-2 (completed, no longer returned) is finally dropped.
    api.GET.and.resolveTo({
      data: { results: [envelope('trip-1')], poll_interval_seconds: 12, server_time: 'T7' },
      response: fakeResponse(200, { etag: 'W/"7"' }),
    });
    await store.poll();

    expect(api.GET.calls.mostRecent().args[1].params.query).toBeUndefined();
    expect(store.trips().map((t) => t.trip.id)).toEqual(['trip-1']);
  });

  it('reports an error and no data on a first-poll failure', async () => {
    api.GET.and.resolveTo({ data: undefined, error: { detail: 'Server error' }, response: fakeResponse(500) });

    await store.poll();

    expect(store.error()).toBe('Server error');
    expect(store.trips()).toEqual([]);
  });

  it('surfaces a later poll failure without blanking the board', async () => {
    api.GET.and.resolveTo({
      data: { results: [envelope('trip-1')], poll_interval_seconds: 12, server_time: 'T1' },
      response: fakeResponse(200, { etag: 'W/"a"' }),
    });
    await store.poll();

    api.GET.and.resolveTo({
      data: undefined,
      error: { detail: 'Timed out' },
      response: fakeResponse(500),
    });
    await store.poll();

    expect(store.error()).toBeNull();
    expect(store.pollError()).toBe('Timed out');
    expect(store.trips().map((t) => t.trip.id)).toEqual(['trip-1']);
  });

  it('flags simulated data whenever any visible trip carries it', async () => {
    api.GET.and.resolveTo({
      data: {
        results: [envelope('trip-1', { position: { ...envelope('trip-1').position, source: 'simulated' } })],
        poll_interval_seconds: 12,
        server_time: 'T1',
      },
      response: fakeResponse(200, { etag: 'W/"a"' }),
    });

    await store.poll();

    expect(store.hasSimulatedData()).toBeTrue();
  });

  it('is empty only once settled with no trips', async () => {
    expect(store.isEmpty()).toBeFalse(); // still loading

    api.GET.and.resolveTo({
      data: { results: [], poll_interval_seconds: 12, server_time: 'T1' },
      response: fakeResponse(200, { etag: 'W/"a"' }),
    });
    await store.poll();

    expect(store.isEmpty()).toBeTrue();
  });
});
