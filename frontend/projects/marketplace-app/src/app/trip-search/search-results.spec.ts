import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { BehaviorSubject } from 'rxjs';

import { addDays, todayIso } from '../shared/dates';
import { SearchResults, operatorColour, operatorInitials, timeBucket } from './search-results';

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
    business_name: 'GUO Transport',
    duration_minutes: null,
    scheduled_arrival_at: null,
    ...overrides,
  };
}

describe('SearchResults', () => {
  let apiClient: { GET: jasmine.Spy };
  let fixture: ComponentFixture<SearchResults>;
  let component: SearchResults;
  let queryParamMap$: BehaviorSubject<ReturnType<typeof convertToParamMap>>;

  function createComponent(): void {
    fixture = TestBed.createComponent(SearchResults);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  function setQueryParams(params: Record<string, string>): void {
    queryParamMap$.next(convertToParamMap(params));
  }

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };
    queryParamMap$ = new BehaviorSubject(
      convertToParamMap({ origin: 'Ikeja', destination: 'CMS', service_date: '2026-09-01' })
    );

    TestBed.configureTestingModule({
      imports: [SearchResults],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: apiClient },
        { provide: ActivatedRoute, useValue: { queryParamMap: queryParamMap$.asObservable() } },
      ],
    });
  });

  it('searches by the origin/destination/date carried in the URL', () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    createComponent();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/marketplace/trips/search/',
      jasmine.objectContaining({
        params: {
          query: { origin: 'Ikeja', destination: 'CMS', service_date: '2026-09-01', limit: 100, offset: 0 },
        },
      })
    );
  });

  it('re-searches when the URL query params change', () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });
    createComponent();
    apiClient.GET.calls.reset();

    setQueryParams({ origin: 'Yaba', destination: 'Ikeja', service_date: '2026-09-02' });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/marketplace/trips/search/',
      jasmine.objectContaining({
        params: {
          query: { origin: 'Yaba', destination: 'Ikeja', service_date: '2026-09-02', limit: 100, offset: 0 },
        },
      })
    );
  });

  it('shows a message rather than searching when the URL is missing something', () => {
    queryParamMap$ = new BehaviorSubject(convertToParamMap({ origin: 'Ikeja' }));
    TestBed.overrideProvider(ActivatedRoute, {
      useValue: { queryParamMap: queryParamMap$.asObservable() },
    });

    createComponent();

    expect(apiClient.GET).not.toHaveBeenCalled();
    expect(component['searchError']()).toContain('missing something');
  });

  it('shows the operator name, fare and stop count on each result card', async () => {
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeTripSearchResult({ stops_between: 0 })] },
    });

    createComponent();
    await fixture.whenStable();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('GUO Transport');
    expect(host.textContent).toContain('NGN 750.00');
    const pills = host.querySelectorAll('ui-status-pill');
    const labels = Array.from(pills).map((pill) => pill.textContent?.trim());
    expect(labels).toContain('Direct');
  });

  it('shows vehicle type, arrival time, and duration when the operator has set them', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 1,
        results: [
          makeTripSearchResult({
            duration_minutes: 90,
            scheduled_arrival_at: '2026-09-01T08:00:00Z',
            trip: {
              ...makeTripSearchResult().trip,
              vehicle: {
                id: 'vehicle-1',
                registration_number: 'LAG-001-XY',
                vehicle_type: { id: 'vt-1', name: 'Luxury Bus' },
              },
            },
          }),
        ],
      },
    });

    createComponent();
    await fixture.whenStable();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('Luxury Bus');
    expect(host.textContent).toContain('1h 30m');
  });

  it('omits duration and arrival gracefully when the operator has not set them', async () => {
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeTripSearchResult()] },
    });

    createComponent();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component['durationLabel'](makeTripSearchResult() as never)).toBeNull();
  });

  it('sorts by lowest price', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 2,
        results: [
          makeTripSearchResult({ fare: { amount: '2000.00', currency: 'NGN' } }),
          makeTripSearchResult({
            trip: { ...makeTripSearchResult().trip, id: 'trip-2' },
            fare: { amount: '750.00', currency: 'NGN' },
          }),
        ],
      },
    });
    createComponent();
    await fixture.whenStable();

    component['onSortChange']('price');

    expect(component['sortedResults']()?.map((row) => row.fare.amount)).toEqual([
      '750.00',
      '2000.00',
    ]);
  });

  it('sorts by shortest duration, with an unset duration sorting last', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 2,
        results: [
          makeTripSearchResult({ duration_minutes: null }),
          makeTripSearchResult({
            trip: { ...makeTripSearchResult().trip, id: 'trip-2' },
            duration_minutes: 45,
          }),
        ],
      },
    });
    createComponent();
    await fixture.whenStable();

    component['onSortChange']('duration');

    expect(component['sortedResults']()?.map((row) => row.duration_minutes)).toEqual([45, null]);
  });

  it('shows an empty state rather than an error when no operator runs that day', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    createComponent();
    await fixture.whenStable();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('ui-empty-state')).toBeTruthy();
    expect(component['searchError']()).toBeNull();
  });

  it('surfaces a search failure with a retry affordance', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Service unavailable.' } });

    createComponent();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component['searchError']()).toBe('Service unavailable.');
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('ui-alert')?.textContent).toContain('Service unavailable.');
  });

  it('names the operator, departure and stop pair in a Select seats button’s accessible label', () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });
    createComponent();

    const label = component['chooseLabel'](
      makeTripSearchResult({
        trip: { ...makeTripSearchResult().trip, trip_class: 'exclusive' },
        business_name: 'GUO Transport',
      }) as never
    );

    expect(label).toContain('GUO Transport');
    expect(label).toContain('Exclusive');
    expect(label).toContain('Select seats');
    expect(label).toContain('Ikeja');
    expect(label).toContain('CMS');
  });

  it('passes the matched trip and stop pair to the seat picker, with the operator name folded into routeName', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });
    createComponent();
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

    await component['selectTrip'](makeTripSearchResult() as never);

    expect(navigateSpy).toHaveBeenCalledWith(['/search/seats'], {
      state: {
        tripId: 'trip-1',
        routeName: 'GUO Transport · Ikeja → CMS',
        serviceDate: '2026-09-01',
        scheduledDepartureAt: '2026-09-01T06:30:00Z',
        fromStop: { id: 'stop-a', name: 'Ikeja' },
        toStop: { id: 'stop-c', name: 'CMS' },
        tripClass: 'standard',
      },
    });
  });
  describe('filters (spec 24)', () => {
    function localIso(hour: number): string {
      const date = new Date(2026, 8, 1, hour, 0, 0);
      return date.toISOString();
    }

    const rows = () => [
      makeTripSearchResult({
        business_name: 'GUO Transport',
        stops_between: 0,
        trip: { ...makeTripSearchResult().trip, id: 'trip-1', scheduled_departure_at: localIso(7) },
      }),
      makeTripSearchResult({
        business_name: 'ABC Transport',
        stops_between: 2,
        fare: { amount: '500.00', currency: 'NGN' },
        trip: {
          ...makeTripSearchResult().trip,
          id: 'trip-2',
          trip_class: 'premium',
          scheduled_departure_at: localIso(14),
        },
      }),
      makeTripSearchResult({
        business_name: 'GUO Transport',
        stops_between: 1,
        fare: { amount: '900.00', currency: 'NGN' },
        trip: { ...makeTripSearchResult().trip, id: 'trip-3', scheduled_departure_at: localIso(19) },
      }),
    ];

    beforeEach(async () => {
      apiClient.GET.and.resolveTo({ data: { count: 3, results: rows() } });
      createComponent();
      await fixture.whenStable();
    });

    it('offers one operator option per operator, with its count and lowest fare', () => {
      expect(component['operatorOptions']()).toEqual([
        { name: 'ABC Transport', count: 1, minFare: 500, currency: 'NGN' },
        { name: 'GUO Transport', count: 2, minFare: 750, currency: 'NGN' },
      ]);
    });

    it('filters by operator', () => {
      component['toggleOperator']('ABC Transport');
      expect(component['sortedResults']()?.map((row) => row.trip.id)).toEqual(['trip-2']);
    });

    it('filters by departure time of day, with a count per bucket', () => {
      expect(component['timeCounts']()).toEqual({ morning: 1, afternoon: 1, evening: 1 });
      component['toggleTime']('evening');
      expect(component['sortedResults']()?.map((row) => row.trip.id)).toEqual(['trip-3']);
    });

    it('filters to direct departures only', () => {
      expect(component['directCount']()).toBe(1);
      component['toggleDirectOnly']();
      expect(component['sortedResults']()?.map((row) => row.trip.id)).toEqual(['trip-1']);
    });

    it('combines filters, and clearing them restores every row', () => {
      component['toggleOperator']('GUO Transport');
      component['toggleTime']('afternoon');
      expect(component['sortedResults']()).toEqual([]);
      expect(component['activeFilterCount']()).toBe(2);

      component['clearFilters']();

      expect(component['sortedResults']()?.length).toBe(3);
      expect(component['activeFilterCount']()).toBe(0);
    });

    it('shows a filtered-empty message distinct from "no departures"', () => {
      component['toggleTime']('afternoon');
      component['toggleDirectOnly']();
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.textContent).toContain('No departures match your filters');
      expect(host.querySelector('ui-empty-state')).toBeNull();
    });

    it('reports each sort tab’s best value over the filtered rows', () => {
      expect(component['sortHighlights']().price).toBe('NGN 500.00');
      component['toggleOperator']('GUO Transport');
      expect(component['sortHighlights']().price).toBe('NGN 750.00');
    });

    it('labels the cheapest row, and re-labels it as filters change (spec 24)', () => {
      const labelled = () =>
        (component['sortedResults']() ?? [])
          .map((row) => [row.trip.id, component['badgesFor'](row)] as const)
          .filter(([, badges]) => badges.length > 0);

      expect(labelled()).toEqual([['trip-2', ['Cheapest']]]);
      component['toggleOperator']('GUO Transport');
      expect(labelled()).toEqual([['trip-1', ['Cheapest']]]);
    });

    it('labels nothing when there is only one row to compare', () => {
      component['toggleOperator']('ABC Transport');
      const [only] = component['sortedResults']() ?? [];
      expect(component['badgesFor'](only)).toEqual([]);
    });

    it('resets filters when a new search runs', () => {
      component['toggleOperator']('GUO Transport');
      setQueryParams({ origin: 'Yaba', destination: 'Ikeja', service_date: '2026-09-02' });
      expect(component['activeFilterCount']()).toBe(0);
    });
  });

  describe('date strip (spec 24)', () => {
    it('offers the searched day ±3', () => {
      const searched = addDays(todayIso(), 10);
      queryParamMap$.next(convertToParamMap({ origin: 'Ikeja', destination: 'CMS', service_date: searched }));
      apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });
      createComponent();

      const days = component['dateStrip']().map((day) => day.value);
      expect(days.length).toBe(7);
      expect(days[0]).toBe(addDays(searched, -3));
      expect(days[6]).toBe(addDays(searched, 3));
    });

    it('omits days before today', () => {
      const today = todayIso();
      queryParamMap$.next(convertToParamMap({ origin: 'Ikeja', destination: 'CMS', service_date: today }));
      apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });
      createComponent();

      const days = component['dateStrip']().map((day) => day.value);
      expect(days[0]).toBe(today);
      expect(days.length).toBe(4);
      expect(component['canGoToPreviousDay']()).toBeFalse();
    });

    it('re-searches another day by rewriting service_date in the URL, keeping the rest', async () => {
      const searched = addDays(todayIso(), 5);
      queryParamMap$.next(
        convertToParamMap({ origin: 'Ikeja', destination: 'CMS', service_date: searched, trip_class: 'premium' })
      );
      apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });
      createComponent();
      const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

      await component['shiftDate'](1);

      expect(navigateSpy).toHaveBeenCalledWith(['/search/results'], {
        queryParams: {
          origin: 'Ikeja',
          destination: 'CMS',
          service_date: addDays(searched, 1),
          trip_class: 'premium',
        },
      });
    });
  });

  describe('card helpers (spec 24)', () => {
    it('buckets departures by local time of day', () => {
      expect(timeBucket(new Date(2026, 8, 1, 11, 59).toISOString())).toBe('morning');
      expect(timeBucket(new Date(2026, 8, 1, 12, 0).toISOString())).toBe('afternoon');
      expect(timeBucket(new Date(2026, 8, 1, 17, 0).toISOString())).toBe('evening');
    });

    it('derives operator initials', () => {
      expect(operatorInitials('GUO Transport')).toBe('GT');
      expect(operatorInitials('Chisco')).toBe('CH');
      expect(operatorInitials('  ')).toBe('?');
    });

    it('labels the fastest only from known durations', async () => {
      apiClient.GET.and.resolveTo({
        data: {
          count: 3,
          results: [
            makeTripSearchResult({ duration_minutes: 90 }),
            makeTripSearchResult({ trip: { ...makeTripSearchResult().trip, id: 'trip-2' }, duration_minutes: 60 }),
            makeTripSearchResult({ trip: { ...makeTripSearchResult().trip, id: 'trip-3' }, duration_minutes: null }),
          ],
        },
      });
      createComponent();
      await fixture.whenStable();

      const fastest = (component['sortedResults']() ?? []).filter((row) =>
        component['badgesFor'](row).includes('Fastest')
      );
      expect(fastest.map((row) => row.trip.id)).toEqual(['trip-2']);
    });

    it('picks the same avatar colour for the same operator every time', () => {
      expect(operatorColour('GUO Transport')).toBe(operatorColour('GUO Transport'));
    });
  });
});
