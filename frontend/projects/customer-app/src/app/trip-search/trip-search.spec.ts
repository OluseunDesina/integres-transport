import { ComponentFixture, TestBed } from '@angular/core/testing';
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
    vehicle: null,
    driver: null,
    booking_mode: 'reservation',
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
      jasmine.objectContaining({ params: { query: { limit: 100, offset: 0 } } })
    );
    expect(component['routeOptions']().map((o) => o.label)).toEqual([
      'Select a route',
      'Ikeja → CMS',
    ]);
  });

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
      },
    });
  });
});
