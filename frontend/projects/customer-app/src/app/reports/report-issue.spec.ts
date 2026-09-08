import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { ReportIssue } from './report-issue';
import { BookingStore } from '../shared/data/store/booking.store';
import { GeolocationService, type LocationResult } from '../shared/geolocation';

function makeRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: 'route-1',
    business: { id: 'biz-1', name: 'Lagos Shuttle Co' },
    name: 'Ikeja → CMS',
    code: 'IKJ-CMS',
    description: '',
    is_active: true,
    stops: [
      { id: 'stop-1', name: 'Ikeja', sequence: 1 },
      { id: 'stop-2', name: 'CMS', sequence: 2 },
    ],
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'booking-1',
    business: 'biz-1',
    trip: {
      id: 'trip-1',
      route: { id: 'route-1', name: 'Ikeja → CMS' },
      scheduled_departure_at: '2026-09-01T07:00:00Z',
      service_date: '2026-09-01',
    },
    passenger: 'user-1',
    status: 'paid',
    total_amount: '300.00',
    currency: 'NGN',
    cancellation_reason: '',
    seats: [],
    created_at: '2026-09-01T06:00:00Z',
    ...overrides,
  };
}

class FakeGeolocationService {
  result: LocationResult = { ok: true, latitude: '6.524379', longitude: '3.379206' };
  current = jasmine.createSpy('current').and.callFake(() => Promise.resolve(this.result));
}

describe('ReportIssue', () => {
  let fixture: ComponentFixture<ReportIssue>;
  let api: { GET: jasmine.Spy; POST: jasmine.Spy };
  let geolocation: FakeGeolocationService;
  let bookings: { findById: jasmine.Spy };
  let navigate: jasmine.Spy;

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function alerts(): string[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('[role="alert"]')
    ).map((node) => node.textContent?.trim() ?? '');
  }

  async function setup(
    queryParams: Record<string, string> = {},
    booking: unknown = makeBooking()
  ): Promise<void> {
    api = {
      GET: jasmine
        .createSpy('GET')
        .and.resolveTo({ data: { count: 1, results: [makeRoute()] } }),
      POST: jasmine.createSpy('POST').and.resolveTo({ data: { reference: 'INC-NEW001' } }),
    };
    geolocation = new FakeGeolocationService();
    bookings = { findById: jasmine.createSpy('findById').and.resolveTo(booking) };

    await TestBed.configureTestingModule({
      imports: [ReportIssue],
      providers: [
        { provide: API_CLIENT, useValue: api },
        { provide: GeolocationService, useValue: geolocation },
        { provide: BookingStore, useValue: bookings },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap(queryParams) } },
        },
      ],
    }).compileComponents();

    navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    fixture = TestBed.createComponent(ReportIssue);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function fill(values: Record<string, string>): void {
    fixture.componentInstance['form'].patchValue(values);
    fixture.detectChanges();
  }

  describe('standalone', () => {
    it('offers a deduped operator picker from GET /routes/browse/', async () => {
      await setup();

      expect(api.GET).toHaveBeenCalledWith('/api/v1/routes/browse/', jasmine.anything());
      const labels = fixture.componentInstance['businessOptions']().map((o) => o.label);
      expect(labels).toContain('Lagos Shuttle Co');
    });

    it('renders a visible error under every required field on an empty submit', async () => {
      await setup();

      await fixture.componentInstance['submit']();
      fixture.detectChanges();

      // The *rendered* output, not merely "no POST fired". A form that
      // binds neither [invalid] nor [errorMessage] silently does
      // nothing on invalid submit, which is how a form in this repo
      // shipped broken.
      const rendered = alerts().join(' | ');
      expect(rendered).toContain('Choose the operator this happened with.');
      expect(rendered).toContain('Choose what went wrong.');
      expect(rendered).toContain('Tell the operator what happened.');
      expect(api.POST).not.toHaveBeenCalled();
    });

    it('files the report and hands the passenger its reference', async () => {
      await setup();
      fill({ business: 'biz-1', category: 'hardware', description: 'No lights on the reader.' });

      await fixture.componentInstance['submit']();

      expect(api.POST).toHaveBeenCalledWith(
        '/api/v1/incidents/report/',
        jasmine.objectContaining({
          body: jasmine.objectContaining({
            business: 'biz-1',
            category: 'hardware',
            description: 'No lights on the reader.',
          }),
        })
      );
      expect(navigate).toHaveBeenCalledWith(['/my-reports'], {
        queryParams: { filed: 'INC-NEW001' },
      });
    });

    it('sends the Idempotency-Key as a header parameter, and the same one twice', async () => {
      await setup();
      fill({ business: 'biz-1', category: 'safety', description: 'Door would not close.' });

      await fixture.componentInstance['submit']();
      await fixture.componentInstance['submit']();

      const [first, second] = api.POST.calls.allArgs();
      // `params.header`, never `headers` — a documented header parameter
      // on this operation.
      expect(first[1].params.header['Idempotency-Key']).toBeTruthy();
      // One key for the life of the form: the second tap of a button
      // that appeared to do nothing must not file a second incident.
      expect(second[1].params.header['Idempotency-Key']).toBe(
        first[1].params.header['Idempotency-Key']
      );
    });

    it('omits optional fields rather than sending them blank', async () => {
      await setup();
      fill({ business: 'biz-1', category: 'other', description: 'Something else.' });

      await fixture.componentInstance['submit']();

      const body = api.POST.calls.mostRecent().args[1].body;
      // An empty string is a value the serializer accepts and stores.
      // The absent key is what "the passenger did not say" looks like.
      expect('route' in body).toBeFalse();
      expect('stop' in body).toBeFalse();
      expect('device_reference' in body).toBeFalse();
      expect('trip' in body).toBeFalse();
      expect('latitude' in body).toBeFalse();
    });

    it('narrows routes to the chosen operator, and stops to the chosen route', async () => {
      await setup();
      fill({ business: 'biz-1' });

      expect(fixture.componentInstance['routeOptions']().map((o) => o.label)).toContain(
        'Ikeja → CMS'
      );
      fill({ route: 'route-1' });
      expect(fixture.componentInstance['stopOptions']().map((o) => o.label)).toContain('CMS');
    });

    it('drops a route that no longer belongs to the selected operator', async () => {
      await setup();
      fill({ business: 'biz-1', route: 'route-1', stop: 'stop-2' });
      expect(fixture.componentInstance['form'].controls.route.value).toBe('route-1');

      // Narrowing a <select>'s options does not move its value into
      // them. Without the reconciling effect this form would submit a
      // route belonging to an operator the passenger just moved away
      // from — and the backend would file it, because the id is real.
      fill({ business: 'biz-other' });

      expect(fixture.componentInstance['form'].controls.route.value).toBe('');
      expect(fixture.componentInstance['form'].controls.stop.value).toBe('');
    });

    it('puts a server field error under the field it belongs to', async () => {
      await setup();
      fill({ business: 'biz-1', category: 'hardware', description: 'x' });
      api.POST.and.resolveTo({ error: { description: ['This field may not be blank.'] } });

      await fixture.componentInstance['submit']();
      fixture.detectChanges();

      expect(alerts().join(' | ')).toContain('This field may not be blank.');
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  describe('location', () => {
    it('attaches nothing until asked, and says so', async () => {
      await setup();

      expect(geolocation.current).not.toHaveBeenCalled();
      expect(text()).toContain('Not attached');
    });

    it('attaches coordinates and sends them', async () => {
      await setup();
      await fixture.componentInstance['attachLocation']();
      fixture.detectChanges();
      expect(text()).toContain('6.524379, 3.379206');

      fill({ business: 'biz-1', category: 'gps', description: 'Bus shown in the wrong place.' });
      await fixture.componentInstance['submit']();

      const body = api.POST.calls.mostRecent().args[1].body;
      expect(body.latitude).toBe('6.524379');
      expect(body.longitude).toBe('3.379206');
    });

    it('treats a refusal as an ordinary outcome and still submits', async () => {
      await setup();
      geolocation.result = { ok: false, reason: 'denied' };
      await fixture.componentInstance['attachLocation']();
      fixture.detectChanges();

      // Stated plainly, not raised as an error: a report with no
      // location is normal, not degraded.
      expect(text()).toContain('your browser declined');
      expect(alerts().join(' ')).not.toContain('declined');

      fill({ business: 'biz-1', category: 'gps', description: 'Anything.' });
      await fixture.componentInstance['submit']();

      expect(api.POST).toHaveBeenCalled();
      expect('latitude' in api.POST.calls.mostRecent().args[1].body).toBeFalse();
    });

    it('names a browser that cannot share a location at all', async () => {
      await setup();
      geolocation.result = { ok: false, reason: 'unsupported' };
      await fixture.componentInstance['attachLocation']();
      fixture.detectChanges();

      expect(text()).toContain('cannot share a location');
    });

    it('lets the passenger take an attached location back off', async () => {
      await setup();
      await fixture.componentInstance['attachLocation']();
      fixture.componentInstance['clearLocation']();
      fixture.detectChanges();

      expect(text()).toContain('Not attached');
    });
  });

  describe('from a booking', () => {
    it('resolves the booking and names the trip instead of asking for an operator', async () => {
      await setup({ booking: 'booking-1' });

      // `findByIdPaged` via the store's `findById`: `/bookings/mine/`
      // has no single-record GET, so the standing rule applies here.
      expect(bookings.findById).toHaveBeenCalledWith('booking-1');
      expect(text()).toContain('Ikeja → CMS');
      expect(text()).not.toContain('Which operator?');
      // Nothing to pick an operator from, so nothing was fetched.
      expect(api.GET).not.toHaveBeenCalled();
    });

    it('files against the booked trip, with the operator taken from the booking', async () => {
      await setup({ booking: 'booking-1' });
      fill({ category: 'service', description: 'The driver skipped my stop.' });

      await fixture.componentInstance['submit']();

      const body = api.POST.calls.mostRecent().args[1].body;
      expect(body.trip).toBe('trip-1');
      expect(body.business).toBe('biz-1');
    });

    it('falls back to the operator picker when the booking cannot be found', async () => {
      await setup({ booking: 'missing' }, null);

      // A dead id in a query param must not be a dead end: the
      // passenger still came here to report something.
      expect(text()).toContain('could not be found');
      expect(api.GET).toHaveBeenCalledWith('/api/v1/routes/browse/', jasmine.anything());
    });
  });
});
