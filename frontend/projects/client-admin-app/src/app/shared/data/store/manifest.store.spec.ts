import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { ManifestStore } from './manifest.store';

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    trip: {
      id: 'trip-1',
      route: 'Ikeja → CMS',
      trip_class: 'standard',
      service_date: '2026-09-07',
      scheduled_departure_at: '2026-09-07T07:00:00Z',
      status: 'scheduled',
      booking_mode: 'reservation',
      fare_collection_mode: 'prepaid',
      vehicle: 'LAG-221-XY',
      driver: 'A. Bello',
    },
    kind: 'prepaid',
    totals: { passengers: 1, boarded: 0, capacity: 44 },
    count: 1,
    next: null,
    previous: null,
    results: [],
    ...overrides,
  };
}

describe('ManifestStore', () => {
  let api: { GET: jasmine.Spy };
  let store: ManifestStore;

  beforeEach(() => {
    api = { GET: jasmine.createSpy('GET').and.resolveTo({ data: envelope() }) };
    TestBed.configureTestingModule({ providers: [{ provide: API_CLIENT, useValue: api }] });
    store = TestBed.inject(ManifestStore);
  });

  it('reads the manifest for one trip, 50 to a page', async () => {
    await store.load('trip-1');

    expect(api.GET).toHaveBeenCalledWith(
      '/api/v1/trips/{id}/manifest/',
      jasmine.objectContaining({
        params: { path: { id: 'trip-1' }, query: { limit: 50, offset: 0 } },
      })
    );
    expect(store.data()?.kind).toBe('prepaid');
    expect(store.total()).toBe(1);
  });

  it('omits include_cancelled when it is off rather than sending false', async () => {
    await store.load('trip-1');

    // The server reads `?include_cancelled=false` as a filter, not as
    // the absence of one — the recorded rule for boolean query params.
    const query = api.GET.calls.mostRecent().args[1].params.query;
    expect('include_cancelled' in query).toBeFalse();
  });

  it('sends include_cancelled and returns to the first page when it is turned on', async () => {
    await store.load('trip-1');
    await store.changePage(50);

    await store.setIncludeCancelled(true);

    const query = api.GET.calls.mostRecent().args[1].params.query;
    expect(query.include_cancelled).toBeTrue();
    // Widening the set while sitting on page 2 would show a different
    // page 2.
    expect(query.offset).toBe(0);
    expect(store.page().offset).toBe(0);
  });

  it('distinguishes a deleted trip from a broken server', async () => {
    api.GET.and.resolveTo({ error: { detail: 'Not found.' }, response: { status: 404 } });

    await store.load('missing');

    // A bookmarked link to a deleted trip is an ordinary thing to
    // happen and reads very differently from "the server broke".
    expect(store.notFound()).toBeTrue();
    expect(store.error()).toBeNull();
  });

  it('surfaces a real failure as an error, not as not-found', async () => {
    api.GET.and.resolveTo({ error: { detail: 'Boom.' }, response: { status: 500 } });

    await store.load('trip-1');

    expect(store.notFound()).toBeFalse();
    expect(store.error()).toBe('Boom.');
  });

  it('is not empty until it has actually answered', async () => {
    expect(store.isEmpty()).toBeFalse();

    await store.load('trip-1');

    // Settled and genuinely empty — distinguishable from "no rows yet",
    // which is what keeps a skeleton from reading as an empty bus.
    expect(store.isEmpty()).toBeTrue();
  });

  it('pages without losing the trip it is showing', async () => {
    await store.load('trip-1');

    await store.changePage(50);

    expect(api.GET.calls.mostRecent().args[1].params).toEqual({
      path: { id: 'trip-1' },
      query: { limit: 50, offset: 50 },
    });
  });
});
