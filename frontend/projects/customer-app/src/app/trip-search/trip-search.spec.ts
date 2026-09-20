import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { TripSearch } from './trip-search';

function makeStopSuggestion(id: string, name: string) {
  return { id, name };
}

function makeTripSearchResult(overrides: Record<string, unknown> = {}) {
  return {
    trip: {
      id: 'trip-1',
      schedule: null,
      route: { id: 'route-1', name: 'Ikeja → CMS' },
      business: 'biz-1',
      service_date: '2026-09-01',
      scheduled_departure_at: '2026-09-01T06:30:00Z',
      status: 'scheduled',
      status_changed_at: null,
      actual_departure_at: null,
      actual_arrival_at: null,
      vehicle: null,
      driver: null,
      booking_mode: 'reservation',
      trip_class: 'standard',
      cancellation_reason: '',
      compliance_warnings: [],
      created_at: '2026-08-06T00:00:00Z',
    },
    from_stop: { id: 'stop-a', name: 'Ikeja' },
    to_stop: { id: 'stop-c', name: 'CMS' },
    stops_between: 0,
    fare: { amount: '750.00', currency: 'NGN' },
    capacity_remaining: null,
    ...overrides,
  };
}

describe('TripSearch', () => {
  let apiClient: { GET: jasmine.Spy };
  let fixture: ComponentFixture<TripSearch>;
  let component: TripSearch;

  function createComponent(): void {
    fixture = TestBed.createComponent(TripSearch);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  async function fillSearchInputs(): Promise<void> {
    component['fromField'].select(makeStopSuggestion('stop-a', 'Ikeja'));
    component['toField'].select(makeStopSuggestion('stop-c', 'CMS'));
    component['onServiceDateChange']('2026-09-01');
  }

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };
    apiClient.GET.and.callFake((path: string) =>
      path === '/api/v1/stops/suggest/'
        ? Promise.resolve({ data: [makeStopSuggestion('stop-a', 'Ikeja')] })
        : Promise.resolve({ data: { count: 0, results: [] } })
    );

    TestBed.configureTestingModule({
      imports: [TripSearch],
      providers: [provideRouter([]), { provide: API_CLIENT, useValue: apiClient }],
    });
  });

  it('cannot search until both stops and a date are filled in', () => {
    createComponent();
    expect(component['canSearch']()).toBeFalse();

    component['fromField'].select(makeStopSuggestion('stop-a', 'Ikeja'));
    expect(component['canSearch']()).toBeFalse();

    component['toField'].select(makeStopSuggestion('stop-c', 'CMS'));
    expect(component['canSearch']()).toBeFalse();

    component['onServiceDateChange']('2026-09-01');
    expect(component['canSearch']()).toBeTrue();
  });

  it('fetches default stop suggestions on focus', fakeAsync(() => {
    createComponent();
    apiClient.GET.calls.reset();

    component['fromField'].onFocus();
    tick();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/stops/suggest/',
      jasmine.objectContaining({ params: { query: { q: undefined } } })
    );
    expect(component['fromField'].open()).toBeTrue();
  }));

  it('debounces typing before fetching filtered stop suggestions', fakeAsync(() => {
    createComponent();
    apiClient.GET.calls.reset();

    component['onFromInput']('yab');
    // Not yet — a keystroke should not fire a request before the
    // debounce window closes, or a search term is one HTTP request per
    // character.
    expect(apiClient.GET).not.toHaveBeenCalled();

    tick(300);

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/stops/suggest/',
      jasmine.objectContaining({ params: { query: { q: 'yab' } } })
    );
  }));

  it('does not fetch again for every keystroke within the debounce window', fakeAsync(() => {
    createComponent();
    apiClient.GET.calls.reset();

    component['onFromInput']('y');
    tick(100);
    component['onFromInput']('ya');
    tick(100);
    component['onFromInput']('yab');
    tick(300);

    expect(apiClient.GET).toHaveBeenCalledTimes(1);
    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/stops/suggest/',
      jasmine.objectContaining({ params: { query: { q: 'yab' } } })
    );
  }));

  it('fills the field and closes the dropdown when a suggestion is chosen', () => {
    createComponent();

    component['selectFromSuggestion'](makeStopSuggestion('stop-a', 'Ikeja'));

    expect(component['fromField'].query()).toBe('Ikeja');
    expect(component['fromField'].open()).toBeFalse();
  });

  it('searches by origin and destination text', async () => {
    createComponent();
    await fillSearchInputs();
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeTripSearchResult()] } });

    await component['search']();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/trips/search/',
      jasmine.objectContaining({
        params: {
          query: {
            origin: 'Ikeja',
            destination: 'CMS',
            service_date: '2026-09-01',
            limit: 100,
            offset: 0,
          },
        },
      })
    );
    expect(component['results']()?.length).toBe(1);
  });

  it('discards stale results when a search input changes', async () => {
    createComponent();
    await fillSearchInputs();
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeTripSearchResult()] } });
    await component['search']();

    component['onServiceDateChange']('2026-09-02');

    expect(component['results']()).toBeNull();
  });

  // --- service classes, docs/specs/15-trip-classes.md slice 3 ---------

  it('offers every class as a filter, unrestricted by any single route', () => {
    createComponent();

    expect(component['tripClassOptions'].map((o) => o.label)).toEqual([
      'All classes',
      'Premium',
      'Exclusive',
      'Standard',
      'Mini',
    ]);
  });

  it('sends the chosen class as a query filter', async () => {
    createComponent();
    await fillSearchInputs();
    component['onTripClassChange']('premium');
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await component['search']();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/trips/search/',
      jasmine.objectContaining({
        params: {
          query: {
            origin: 'Ikeja',
            destination: 'CMS',
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
    createComponent();
    await fillSearchInputs();
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await component['search']();

    const query = apiClient.GET.calls.mostRecent().args[1].params.query;
    expect('trip_class' in query).toBeFalse();
  });

  // --- results -----------------------------------------------------

  it('shows the fare and stop count on each result card', async () => {
    createComponent();
    await fillSearchInputs();
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeTripSearchResult({ stops_between: 0 })] },
    });

    await component['search']();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('NGN 750.00');
    const pills = host.querySelectorAll('ui-status-pill');
    const labels = Array.from(pills).map((pill) => pill.textContent?.trim());
    expect(labels).toContain('Direct');
  });

  it('shows how many seats are left when capacity is tracked', async () => {
    createComponent();
    await fillSearchInputs();
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeTripSearchResult({ capacity_remaining: 3 })] },
    });

    await component['search']();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('3 seats left');
  });

  it('shows "Book now" with a footer strip of date, vehicle type and seats left', async () => {
    createComponent();
    await fillSearchInputs();
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [
          makeTripSearchResult({
            capacity_remaining: 5,
            trip: {
              ...makeTripSearchResult().trip,
              vehicle: {
                id: 'vehicle-1',
                registration_number: 'LND-123-XY',
                vehicle_type: { id: 'vt-1', name: 'Coach' },
              },
            },
          }),
        ],
      },
    });

    await component['search']();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('Book now');
    expect(host.textContent).not.toContain('Continue');
    expect(host.textContent).toContain('Coach');
    expect(host.textContent).toContain('LND-123-XY');
    // calendar-days (date), truck (vehicle type), users (seats left).
    expect(host.querySelectorAll('ui-icon').length).toBeGreaterThanOrEqual(3);
  });

  it('says nothing about seats left when capacity is not tracked', async () => {
    createComponent();
    await fillSearchInputs();
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeTripSearchResult({ capacity_remaining: null })] },
    });

    await component['search']();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('left');
  });

  it('labels a multi-stop result with a stop count, not "Direct"', async () => {
    createComponent();
    await fillSearchInputs();
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeTripSearchResult({ stops_between: 2 })] },
    });

    await component['search']();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const pills = host.querySelectorAll('ui-status-pill');
    const labels = Array.from(pills).map((pill) => pill.textContent?.trim());
    expect(labels).toContain('2 stops');
  });

  it('renders each departure’s class as a pill on its card', async () => {
    createComponent();
    await fillSearchInputs();
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [makeTripSearchResult({ trip: { ...makeTripSearchResult().trip, trip_class: 'premium' } })],
      },
    });

    await component['search']();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const pill = host.querySelector('ui-status-pill');
    expect(pill?.textContent).toContain('Premium');
  });

  it('names the departure and stop pair in a Continue button’s accessible label', () => {
    createComponent();

    const label = component['chooseLabel'](makeTripSearchResult({
      trip: { ...makeTripSearchResult().trip, trip_class: 'exclusive' },
    }) as never);

    expect(label).toContain('Exclusive');
    expect(label).toContain('Continue');
    expect(label).toContain('Ikeja');
    expect(label).toContain('CMS');
  });

  it('shows an empty state rather than an error when nothing runs that day', async () => {
    createComponent();
    await fillSearchInputs();

    await component['search']();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('ui-empty-state')).toBeTruthy();
    expect(component['searchError']()).toBeNull();
  });

  it('surfaces a search failure with a retry affordance', async () => {
    createComponent();
    await fillSearchInputs();
    apiClient.GET.and.resolveTo({ error: { detail: 'Service unavailable.' } });

    await component['search']();
    fixture.detectChanges();

    expect(component['searchError']()).toBe('Service unavailable.');
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('ui-alert')?.textContent).toContain('Service unavailable.');
  });

  it('passes the matched trip and stop pair to the seat picker via router state', async () => {
    createComponent();
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

    await component['selectTrip'](makeTripSearchResult() as never);

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
