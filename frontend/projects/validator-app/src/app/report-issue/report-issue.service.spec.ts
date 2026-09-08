import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { ReportIssueService } from './report-issue.service';
import type { Trip } from '../shared/open-trips.service';

function makeTrip(overrides: Record<string, unknown> = {}): Trip {
  return {
    id: 'trip-1',
    schedule: null,
    route: { id: 'route-1', name: 'Ikeja → CMS' },
    business: 'biz-1',
    service_date: '2026-09-06',
    scheduled_departure_at: '2026-09-06T08:00:00Z',
    status: 'in_progress',
    status_changed_at: null,
    actual_departure_at: null,
    actual_arrival_at: null,
    vehicle: { id: 'vehicle-1', registration_number: 'LAG-123-XY' },
    driver: { id: 'driver-1', name: 'Ada Obi' },
    booking_mode: 'reservation',
    fare_collection_mode: 'prepaid',
    trip_class: 'standard',
    cancellation_reason: '',
    compliance_warnings: [],
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  } as Trip;
}

describe('ReportIssueService', () => {
  let apiClient: { POST: jasmine.Spy };
  let service: ReportIssueService;

  function report(trip = makeTrip()) {
    return service.report({
      trip,
      category: 'hardware',
      title: 'Reader is dead',
      severity: 'high',
      description: 'No lights.',
      deviceReference: 'RDR-07',
    });
  }

  beforeEach(() => {
    apiClient = {
      POST: jasmine
        .createSpy('POST')
        .and.resolveTo({ data: { reference: 'INC-XY12ZW' }, response: { status: 201 } }),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });
    service = TestBed.inject(ReportIssueService);
  });

  it('files through the operator endpoint, not the passenger one', async () => {
    await report();

    // A conductor is staff. `POST /incidents/` records `source=operator`
    // and accepts `severity`; `/incidents/report/` would have filed the
    // same fault as a passenger report and dropped the urgency.
    expect(apiClient.POST.calls.mostRecent().args[0]).toBe('/api/v1/incidents/');
    expect(apiClient.POST.calls.mostRecent().args[1].body.severity).toBe('high');
  });

  it('attaches the business, route and vehicle the trip already names', async () => {
    await report();
    const body = apiClient.POST.calls.mostRecent().args[1].body;

    // A fault report that does not say which bus it is about is a fault
    // report nobody can act on.
    expect(body.business).toBe('biz-1');
    expect(body.trip).toBe('trip-1');
    expect(body.route).toBe('route-1');
    expect(body.vehicle).toBe('vehicle-1');
  });

  it('never attaches the driver, though the trip carries one', async () => {
    await report();

    // Naming a person on every hardware fault turns "this reader is
    // dead" into a record about whoever happened to be driving.
    expect('driver' in apiClient.POST.calls.mostRecent().args[1].body).toBeFalse();
  });

  it('omits the vehicle when no bus has been assigned yet', async () => {
    await report(makeTrip({ vehicle: null }));

    expect('vehicle' in apiClient.POST.calls.mostRecent().args[1].body).toBeFalse();
  });

  it('sends the Idempotency-Key as a header parameter', async () => {
    await report();

    // A documented header *parameter* on this operation, so it travels
    // in `params.header` — never in `headers`.
    expect(
      apiClient.POST.calls.mostRecent().args[1].params.header['Idempotency-Key']
    ).toBeTruthy();
  });

  it('hands back the server’s own message when the report is refused', async () => {
    apiClient.POST.and.resolveTo({
      error: { detail: 'You do not have permission to perform this action.' },
      response: { status: 403 },
    });

    const result = await report();

    expect(result).toEqual({
      ok: false,
      status: 403,
      message: 'You do not have permission to perform this action.',
    });
  });
});
