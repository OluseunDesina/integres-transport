import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { ValidateTicketService, type TicketValidationResult } from './validate-ticket.service';

function makeTrip(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trip-1',
    schedule: null,
    route: { id: 'route-1', name: 'Ikeja → CMS' },
    business: 'biz-1',
    service_date: '2026-09-01',
    scheduled_departure_at: '2026-09-01T06:30:00Z',
    status: 'scheduled',
    status_changed_at: null,
    vehicle: null,
    driver: null,
    booking_mode: 'reservation',
    cancellation_reason: '',
    compliance_warnings: [],
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

describe('ValidateTicketService', () => {
  let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy };
  let service: ValidateTicketService;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET'), POST: jasmine.createSpy('POST') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    service = TestBed.inject(ValidateTicketService);
  });

  describe('loadTripsForDate', () => {
    it('merges scheduled and in_progress trips and filters out tap_and_go', async () => {
      apiClient.GET.withArgs(
        '/api/v1/trips/',
        jasmine.objectContaining({
          params: jasmine.objectContaining({ query: jasmine.objectContaining({ status: 'scheduled' }) }),
        })
      ).and.resolveTo({
        data: {
          count: 2,
          results: [
            makeTrip({ id: 'a', scheduled_departure_at: '2026-09-01T08:00:00Z' }),
            makeTrip({ id: 'b', booking_mode: 'tap_and_go' }),
          ],
        },
      });
      apiClient.GET.withArgs(
        '/api/v1/trips/',
        jasmine.objectContaining({
          params: jasmine.objectContaining({ query: jasmine.objectContaining({ status: 'in_progress' }) }),
        })
      ).and.resolveTo({
        data: { count: 1, results: [makeTrip({ id: 'c', scheduled_departure_at: '2026-09-01T05:00:00Z' })] },
      });

      const trips = await service.loadTripsForDate('2026-09-01');

      // Only reservation-mode trips ('b' excluded), sorted by departure time.
      expect(trips.map((trip) => trip.id)).toEqual(['c', 'a']);
    });

    it('returns an empty list when both requests fail', async () => {
      apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

      const trips = await service.loadTripsForDate('2026-09-01');

      expect(trips).toEqual([]);
    });
  });

  describe('validateTicket', () => {
    it('returns the TicketValidationResult on success', async () => {
      const result: TicketValidationResult = {
        status: 'boarded',
        passenger_name: 'Ada Obi',
        seat_number: '1A',
        from_stop: 'Ikeja',
        to_stop: 'CMS',
        trip_departure_at: '2026-09-01T06:30:00Z',
      };
      apiClient.POST.and.resolveTo({ data: result });

      const outcome = await service.validateTicket({ tripId: 'trip-1', payload: 'signed-payload' });

      expect(outcome).toEqual({ ok: true, data: result });
      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/trips/{trip_id}/tickets/validate/',
        jasmine.objectContaining({
          params: jasmine.objectContaining({ path: { trip_id: 'trip-1' } }),
          body: { payload: 'signed-payload' },
        })
      );
    });

    it('maps a failure to {ok:false, status, message}', async () => {
      apiClient.POST.and.resolveTo({
        error: { detail: 'This ticket has already been boarded.' },
        response: { status: 409 },
      });

      const outcome = await service.validateTicket({ tripId: 'trip-1', payload: 'signed-payload' });

      expect(outcome).toEqual({
        ok: false,
        status: 409,
        message: 'This ticket has already been boarded.',
      });
    });
  });
});
