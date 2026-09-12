import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { TripSearch } from './trip-search';

function makeStop(id: string, name: string, sequence: number) {
  return {
    id,
    business: 'biz-1',
    name,
    address: '',
    latitude: null,
    longitude: null,
    is_active: true,
    created_at: '2026-08-01T00:00:00Z',
    sequence,
  };
}

function makeRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: 'route-1',
    business: { id: 'biz-1', name: 'Lagos Shuttle Co' },
    name: 'Ikeja → CMS',
    code: 'IKJ-CMS',
    description: '',
    is_active: true,
    // Empty means "no restriction", which is the state every Route
    // created before spec 15 is in — so it is the honest default here.
    available_trip_classes: [],
    stops: [makeStop('stop-a', 'Ikeja', 1), makeStop('stop-b', 'Yaba', 2), makeStop('stop-c', 'CMS', 3)],
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

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
    // docs/specs/16-operational-analytics.md slice 1 — null
    // on every Trip that has not departed, which is most of them.
    actual_departure_at: null,
    actual_arrival_at: null,
    vehicle: null,
    driver: null,
    booking_mode: 'reservation',
    trip_class: 'standard',
    cancellation_reason: '',
    compliance_warnings: [],
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

describe('TripSearch', () => {
  let apiClient: { GET: jasmine.Spy };
  let fixture: ComponentFixture<TripSearch>;
  let component: TripSearch;

  async function createComponent(): Promise<void> {
    fixture = TestBed.createComponent(TripSearch);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };
    apiClient.GET.and.callFake((path: string) =>
      path === '/api/v1/routes/browse/'
        ? Promise.resolve({ data: { count: 1, results: [makeRoute()] } })
        : Promise.resolve({ data: { count: 0, results: [] } })
    );

    TestBed.configureTestingModule({
      imports: [TripSearch],
      providers: [provideRouter([]), { provide: API_CLIENT, useValue: apiClient }],
    });
  });

  it('loads browsable routes on init', async () => {
    await createComponent();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/routes/browse/',
      jasmine.objectContaining({
        params: { query: { limit: 100, offset: 0, search: undefined } },
      })
    );
    expect(component['routeOptions']().map((o) => o.label)).toEqual([
      'Select a route',
      'Ikeja → CMS',
    ]);
  });

  it('debounces a route search term and forwards it to the browse endpoint', fakeAsync(() => {
    fixture = TestBed.createComponent(TripSearch);
    component = fixture.componentInstance;
    fixture.detectChanges();
    tick();
    fixture.detectChanges();
    apiClient.GET.calls.reset();

    component['onRouteSearchInput']('yaba');
    // Not yet — a keystroke should not fire a request before the
    // debounce window closes, or a search term is one HTTP request per
    // character against a paginated endpoint.
    expect(apiClient.GET).not.toHaveBeenCalled();

    tick(300);

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/routes/browse/',
      jasmine.objectContaining({
        params: { query: { limit: 100, offset: 0, search: 'yaba' } },
      })
    );
  }));

  it('does not fetch again for every keystroke within the debounce window', fakeAsync(() => {
    fixture = TestBed.createComponent(TripSearch);
    component = fixture.componentInstance;
    fixture.detectChanges();
    tick();
    fixture.detectChanges();
    apiClient.GET.calls.reset();

    component['onRouteSearchInput']('y');
    tick(100);
    component['onRouteSearchInput']('ya');
    tick(100);
    component['onRouteSearchInput']('yab');
    tick(300);

    expect(apiClient.GET).toHaveBeenCalledTimes(1);
    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/routes/browse/',
      jasmine.objectContaining({
        params: { query: { limit: 100, offset: 0, search: 'yab' } },
      })
    );
  }));

  it('labels route options with their Business only when a Client runs several', async () => {
    apiClient.GET.and.callFake((path: string) =>
      path === '/api/v1/routes/browse/'
        ? Promise.resolve({
            data: {
              count: 2,
              results: [
                makeRoute(),
                makeRoute({
                  id: 'route-2',
                  name: 'Gaborone Loop',
                  business: { id: 'biz-2', name: 'Botswana Transit' },
                }),
              ],
            },
          })
        : Promise.resolve({ data: { count: 0, results: [] } })
    );

    await createComponent();

    expect(component['routeOptions']().map((o) => o.label)).toEqual([
      'Select a route',
      'Ikeja → CMS — Lagos Shuttle Co',
      'Gaborone Loop — Botswana Transit',
    ]);
  });

  it('surfaces a route load failure with a retry affordance', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Service unavailable.' } });

    await createComponent();

    expect(component['routesError']()).toBe('Service unavailable.');
    expect((fixture.nativeElement as HTMLElement).querySelector('ui-alert')?.textContent).toContain(
      'Service unavailable.'
    );
  });

  it('populates from-stop options from the selected route', async () => {
    await createComponent();

    component['onRouteChange']('route-1');

    expect(component['fromStopOptions']().map((o) => o.label)).toEqual([
      'Select a stop',
      '1. Ikeja',
      '2. Yaba',
      '3. CMS',
    ]);
  });

  it('offers only stops after the from-stop, so an invalid segment is unreachable', async () => {
    await createComponent();
    component['onRouteChange']('route-1');

    component['onFromStopChange']('stop-b');

    expect(component['toStopOptions']().map((o) => o.label)).toEqual(['Select a stop', '3. CMS']);
  });

  it('clears the stop selection when the route changes', async () => {
    await createComponent();
    component['onRouteChange']('route-1');
    component['onFromStopChange']('stop-a');
    component['onToStopChange']('stop-c');

    component['onRouteChange']('route-2');

    expect(component['fromStopId']()).toBe('');
    expect(component['toStopId']()).toBe('');
  });

  it('cannot search until route, both stops and a date are chosen', async () => {
    await createComponent();
    expect(component['canSearch']()).toBeFalse();

    component['onRouteChange']('route-1');
    component['onFromStopChange']('stop-a');
    component['onToStopChange']('stop-c');
    expect(component['canSearch']()).toBeFalse();

    component['onServiceDateChange']('2026-09-01');
    expect(component['canSearch']()).toBeTrue();
  });

  it('searches trips on the chosen route and date', async () => {
    await createComponent();
    component['onRouteChange']('route-1');
    component['onFromStopChange']('stop-a');
    component['onToStopChange']('stop-c');
    component['onServiceDateChange']('2026-09-01');
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeTrip()] } });

    await component['search']();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/trips/search/',
      jasmine.objectContaining({
        params: {
          query: { route: 'route-1', service_date: '2026-09-01', limit: 100, offset: 0 },
        },
      })
    );
    expect(component['trips']()?.length).toBe(1);
  });

  // --- service classes, docs/specs/15-trip-classes.md slice 3 ---------

  it('offers every class when the route restricts none', async () => {
    await createComponent();

    component['onRouteChange']('route-1');

    expect(component['tripClassOptions']().map((o) => o.label)).toEqual([
      'All classes',
      'Premium',
      'Exclusive',
      'Standard',
      'Mini',
    ]);
  });

  it('narrows the class options to what the chosen route runs', async () => {
    apiClient.GET.and.callFake((path: string) =>
      path === '/api/v1/routes/browse/'
        ? Promise.resolve({
            data: {
              count: 1,
              results: [makeRoute({ available_trip_classes: ['premium', 'mini'] })],
            },
          })
        : Promise.resolve({ data: { count: 0, results: [] } })
    );
    await createComponent();

    component['onRouteChange']('route-1');

    expect(component['tripClassOptions']().map((o) => o.label)).toEqual([
      'All classes',
      'Premium',
      'Mini',
    ]);
  });

  it('clears a chosen class when the route changes, so it cannot outlive its options', async () => {
    // The trap spec 15 slice 2 recorded: narrowing a <select>'s options
    // does not move a held value into them. A control still holding
    // `premium` against a route that does not run it renders a select
    // with no matching option — it looks empty, keeps its value, and
    // searches for departures that cannot exist.
    await createComponent();
    component['onRouteChange']('route-1');
    component['onTripClassChange']('premium');

    component['onRouteChange']('route-2');

    expect(component['tripClass']()).toBe('');
  });

  it('sends the chosen class as a query filter', async () => {
    await createComponent();
    component['onRouteChange']('route-1');
    component['onFromStopChange']('stop-a');
    component['onToStopChange']('stop-c');
    component['onServiceDateChange']('2026-09-01');
    component['onTripClassChange']('premium');
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await component['search']();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/trips/search/',
      jasmine.objectContaining({
        params: {
          query: {
            route: 'route-1',
            service_date: '2026-09-01',
            trip_class: 'premium',
            limit: 100,
            offset: 0,
          },
        },
      })
    );
  });

  it('omits the class key entirely when no class is chosen', async () => {
    // `trip_class` is a ChoiceField server-side, so `''` is a 400 rather
    // than "no filter" — the key has to be absent, not empty.
    await createComponent();
    component['onRouteChange']('route-1');
    component['onFromStopChange']('stop-a');
    component['onToStopChange']('stop-c');
    component['onServiceDateChange']('2026-09-01');
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await component['search']();

    const query = apiClient.GET.calls.mostRecent().args[1].params.query;
    expect('trip_class' in query).toBeFalse();
  });

  it('renders each departure’s class as a pill on its card', async () => {
    await createComponent();
    component['onRouteChange']('route-1');
    component['onFromStopChange']('stop-a');
    component['onToStopChange']('stop-c');
    component['onServiceDateChange']('2026-09-01');
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeTrip({ trip_class: 'premium' })] },
    });

    await component['search']();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const pill = host.querySelector('ui-status-pill');
    // The label, not only a colour — the pill is neutral-toned on
    // purpose, so the word is the whole signal.
    expect(pill?.textContent).toContain('Premium');
    // On the departure card itself, beside the route it qualifies —
    // not somewhere else on the page.
    expect(pill?.closest('li')?.textContent).toContain('Ikeja → CMS');
  });

  it('names the class in a Continue button’s accessible label', async () => {
    // One route can run two departures minutes apart at two prices; the
    // pill is not part of the button's accessible name, so without this
    // a screen reader hears two identical labels.
    await createComponent();

    const label = component['chooseLabel'](makeTrip({ trip_class: 'exclusive' }) as never);

    expect(label).toContain('Exclusive');
    expect(label).toContain('Continue');
  });

  it('shows an empty state rather than an error when nothing runs that day', async () => {
    await createComponent();
    component['onRouteChange']('route-1');
    component['onFromStopChange']('stop-a');
    component['onToStopChange']('stop-c');
    component['onServiceDateChange']('2026-12-25');

    await component['search']();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('ui-empty-state')).toBeTruthy();
    expect(component['searchError']()).toBeNull();
  });

  it('discards stale results when the search inputs change', async () => {
    await createComponent();
    component['onRouteChange']('route-1');
    component['onFromStopChange']('stop-a');
    component['onToStopChange']('stop-c');
    component['onServiceDateChange']('2026-09-01');
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeTrip()] } });
    await component['search']();

    component['onServiceDateChange']('2026-09-02');

    expect(component['trips']()).toBeNull();
  });

  it('passes the chosen trip and segment to the seat picker via router state', async () => {
    await createComponent();
    component['onRouteChange']('route-1');
    component['onFromStopChange']('stop-a');
    component['onToStopChange']('stop-c');
    component['onServiceDateChange']('2026-09-01');
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

    await component['selectTrip'](makeTrip() as never);

    expect(navigateSpy).toHaveBeenCalledWith(['/search/seats'], {
      state: {
        tripId: 'trip-1',
        routeName: 'Ikeja → CMS',
        serviceDate: '2026-09-01',
        scheduledDepartureAt: '2026-09-01T06:30:00Z',
        fromStop: { id: 'stop-a', name: 'Ikeja' },
        toStop: { id: 'stop-c', name: 'CMS' },
        tripClass: 'standard',
      },
    });
  });
});
