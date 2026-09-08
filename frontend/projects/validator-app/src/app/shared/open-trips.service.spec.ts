import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { OpenTripsService, type Trip } from './open-trips.service';

function makeTrip(overrides: Record<string, unknown> = {}): Trip {
  return {
    id: 'trip-1',
    schedule: null,
    route: { id: 'route-1', name: 'Ikeja → CMS' },
    business: 'biz-1',
    service_date: '2026-09-06',
    scheduled_departure_at: '2026-09-06T08:00:00Z',
    status: 'scheduled',
    status_changed_at: null,
    actual_departure_at: null,
    actual_arrival_at: null,
    vehicle: null,
    driver: null,
    booking_mode: 'reservation',
    fare_collection_mode: 'prepaid',
    trip_class: 'standard',
    cancellation_reason: '',
    compliance_warnings: [],
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  } as Trip;
}

describe('OpenTripsService', () => {
  let apiClient: { GET: jasmine.Spy };
  let service: OpenTripsService;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET').and.resolveTo({ data: { results: [] } }) };
    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });
    service = TestBed.inject(OpenTripsService);
  });

  it('asks for scheduled and in-progress separately, because one request cannot take both', async () => {
    await service.loadForDate('2026-09-06');

    const statuses = apiClient.GET.calls.allArgs().map((args) => args[1].params.query.status);
    expect(statuses).toEqual(['scheduled', 'in_progress']);
  });

  it('applies no fare-mode filter of its own', async () => {
    apiClient.GET.and.returnValues(
      Promise.resolve({
        data: { results: [makeTrip({ id: 'prepaid', fare_collection_mode: 'prepaid' })] },
      }),
      Promise.resolve({
        data: {
          results: [makeTrip({ id: 'payg', fare_collection_mode: 'pay_as_you_go' })],
        },
      })
    );

    const trips = await service.loadForDate('2026-09-06');

    // A tap credential is universal fare media, so narrowing by mode
    // here would make one of them unreachable for every caller. Callers
    // that need a narrower set filter the result themselves.
    expect(trips.map((trip) => trip.id).sort()).toEqual(['payg', 'prepaid']);
  });

  it('reads as a timetable, earliest departure first', async () => {
    apiClient.GET.and.returnValues(
      Promise.resolve({
        data: {
          results: [makeTrip({ id: 'later', scheduled_departure_at: '2026-09-06T17:00:00Z' })],
        },
      }),
      Promise.resolve({
        data: {
          results: [makeTrip({ id: 'earlier', scheduled_departure_at: '2026-09-06T06:00:00Z' })],
        },
      })
    );

    const trips = await service.loadForDate('2026-09-06');

    expect(trips.map((trip) => trip.id)).toEqual(['earlier', 'later']);
  });

  it('returns an empty list rather than throwing when a page comes back empty', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

    expect(await service.loadForDate('2026-09-06')).toEqual([]);
  });
});
