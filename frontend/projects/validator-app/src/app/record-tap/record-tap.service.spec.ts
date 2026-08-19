import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { RecordTapService, type TapEvent } from './record-tap.service';

function makeTrip(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trip-1',
    schedule: null,
    route: { id: 'route-1', name: 'Gaborone Loop' },
    business: 'biz-1',
    service_date: '2026-09-01',
    scheduled_departure_at: '2026-09-01T06:30:00Z',
    status: 'scheduled',
    status_changed_at: null,
    vehicle: null,
    driver: null,
    booking_mode: 'tap_and_go',
    cancellation_reason: '',
    compliance_warnings: [],
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

describe('RecordTapService', () => {
  let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy };
  let service: RecordTapService;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET'), POST: jasmine.createSpy('POST') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    service = TestBed.inject(RecordTapService);
  });

  describe('loadTripsForDate', () => {
    it('merges scheduled and in_progress trips and filters to tap_and_go', async () => {
      apiClient.GET.withArgs(
        '/api/v1/trips/',
        jasmine.objectContaining({ params: jasmine.objectContaining({ query: jasmine.objectContaining({ status: 'scheduled' }) }) })
      ).and.resolveTo({
        data: {
          count: 2,
          results: [
            makeTrip({ id: 'a', scheduled_departure_at: '2026-09-01T08:00:00Z' }),
            makeTrip({ id: 'b', booking_mode: 'reservation' }),
          ],
        },
      });
      apiClient.GET.withArgs(
        '/api/v1/trips/',
        jasmine.objectContaining({ params: jasmine.objectContaining({ query: jasmine.objectContaining({ status: 'in_progress' }) }) })
      ).and.resolveTo({
        data: { count: 1, results: [makeTrip({ id: 'c', scheduled_departure_at: '2026-09-01T05:00:00Z' })] },
      });

      const trips = await service.loadTripsForDate('2026-09-01');

      // Only tap_and_go trips ('b' excluded), sorted by departure time.
      expect(trips.map((trip) => trip.id)).toEqual(['c', 'a']);
    });

    it('returns an empty list when both requests fail', async () => {
      apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

      const trips = await service.loadTripsForDate('2026-09-01');

      expect(trips).toEqual([]);
    });
  });

  describe('loadRouteStops', () => {
    it('finds the matching route and returns its ordered stops', async () => {
      apiClient.GET.and.resolveTo({
        data: {
          count: 1,
          results: [
            {
              id: 'route-1',
              business: 'biz-1',
              name: 'Gaborone Loop',
              code: '',
              description: '',
              is_active: true,
              stops: [
                { id: 'stop-1', business: 'biz-1', name: 'CBD', address: '', latitude: null, longitude: null, is_active: true, created_at: '2026-01-01T00:00:00Z', sequence: 1 },
                { id: 'stop-2', business: 'biz-1', name: 'Mall', address: '', latitude: null, longitude: null, is_active: true, created_at: '2026-01-01T00:00:00Z', sequence: 2 },
              ],
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
        },
      });

      const stops = await service.loadRouteStops('biz-1', 'route-1');

      expect(stops).toEqual([
        { id: 'stop-1', name: 'CBD', sequence: 1 },
        { id: 'stop-2', name: 'Mall', sequence: 2 },
      ]);
    });

    it('returns an empty list when no route matches', async () => {
      apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

      const stops = await service.loadRouteStops('biz-1', 'unknown-route');

      expect(stops).toEqual([]);
    });
  });

  describe('recordTap', () => {
    it('returns the TapEvent on success', async () => {
      const tapEvent: TapEvent = {
        id: 'tap-1',
        trip: 'trip-1',
        tap_type: 'board',
        stop: 'stop-1',
        tapped_at: '2026-09-01T08:00:00Z',
        journey: { id: 'journey-1', status: 'open', amount: null, currency: '' },
      };
      apiClient.POST.and.resolveTo({ data: tapEvent });

      const outcome = await service.recordTap({
        tripId: 'trip-1',
        token: 'tok',
        tapType: 'board',
        stopId: 'stop-1',
      });

      expect(outcome).toEqual({ ok: true, data: tapEvent });
      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/trips/{trip_id}/taps/',
        jasmine.objectContaining({
          params: jasmine.objectContaining({ path: { trip_id: 'trip-1' } }),
          body: { token: 'tok', tap_type: 'board', stop_id: 'stop-1' },
        })
      );
    });

    it('maps a failure to {ok:false, status, message}', async () => {
      apiClient.POST.and.resolveTo({
        error: { detail: 'This passenger already has an open tap-and-go journey.' },
        response: { status: 409 },
      });

      const outcome = await service.recordTap({
        tripId: 'trip-1',
        token: 'tok',
        tapType: 'board',
        stopId: 'stop-1',
      });

      expect(outcome).toEqual({
        ok: false,
        status: 409,
        message: 'This passenger already has an open tap-and-go journey.',
      });
    });
  });
});
