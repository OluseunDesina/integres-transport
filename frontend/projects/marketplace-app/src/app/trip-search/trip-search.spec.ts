import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { addDays, todayIso } from '../shared/dates';
import { TripSearch } from './trip-search';

function makeStopSuggestion(id: string, name: string) {
  return { id, name };
}

describe('TripSearch (marketplace)', () => {
  let apiClient: { GET: jasmine.Spy };
  let fixture: ComponentFixture<TripSearch>;
  let component: TripSearch;

  function createComponent(): void {
    fixture = TestBed.createComponent(TripSearch);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.removeItem('marketplace.recentSearches');
    apiClient = { GET: jasmine.createSpy('GET') };
    apiClient.GET.and.resolveTo({ data: [makeStopSuggestion('stop-a', 'Ikeja')] });

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

  it('fetches default stop suggestions from the marketplace endpoint on focus', fakeAsync(() => {
    createComponent();
    apiClient.GET.calls.reset();

    component['fromField'].onFocus();
    tick();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/marketplace/stops/suggest/',
      jasmine.objectContaining({ params: { query: { q: undefined } } })
    );
    expect(component['fromField'].open()).toBeTrue();
  }));

  it('debounces typing before fetching filtered stop suggestions', fakeAsync(() => {
    createComponent();
    apiClient.GET.calls.reset();

    component['onFromInput']('yab');
    expect(apiClient.GET).not.toHaveBeenCalled();

    tick(300);

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/marketplace/stops/suggest/',
      jasmine.objectContaining({ params: { query: { q: 'yab' } } })
    );
  }));

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

  it('navigates to /search/results with the search as query params', async () => {
    createComponent();
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    component['fromField'].select(makeStopSuggestion('stop-a', 'Ikeja'));
    component['toField'].select(makeStopSuggestion('stop-c', 'CMS'));
    component['onServiceDateChange']('2026-09-01');

    await component['search']();

    expect(navigateSpy).toHaveBeenCalledWith(['/search/results'], {
      queryParams: {
        origin: 'Ikeja',
        destination: 'CMS',
        service_date: '2026-09-01',
        trip_class: undefined,
      },
    });
  });

  it('carries the chosen class through as a query param', async () => {
    createComponent();
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    component['fromField'].select(makeStopSuggestion('stop-a', 'Ikeja'));
    component['toField'].select(makeStopSuggestion('stop-c', 'CMS'));
    component['onServiceDateChange']('2026-09-01');
    component['onTripClassChange']('exclusive');

    await component['search']();

    expect(navigateSpy).toHaveBeenCalledWith(['/search/results'], {
      queryParams: {
        origin: 'Ikeja',
        destination: 'CMS',
        service_date: '2026-09-01',
        trip_class: 'exclusive',
      },
    });
  });

  it('does not navigate until the search is fillable', async () => {
    createComponent();
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

    await component['search']();

    expect(navigateSpy).not.toHaveBeenCalled();
  });
  it('prefills the form from the URL, so "Modify search" keeps the search (spec 24)', async () => {
    await TestBed.inject(Router).navigateByUrl(
      '/?origin=Ikeja&destination=CMS&service_date=2026-09-01&trip_class=exclusive'
    );
    createComponent();

    expect(component['fromField'].query()).toBe('Ikeja');
    expect(component['toField'].query()).toBe('CMS');
    expect(component['serviceDate']()).toBe('2026-09-01');
    expect(component['tripClass']()).toBe('exclusive');
    expect(component['canSearch']()).toBeTrue();
  });

  it('swaps origin and destination', () => {
    createComponent();
    component['fromField'].select(makeStopSuggestion('stop-a', 'Ikeja'));
    component['toField'].select(makeStopSuggestion('stop-c', 'CMS'));

    component['swap']();

    expect(component['fromField'].query()).toBe('CMS');
    expect(component['toField'].query()).toBe('Ikeja');
  });

  it('offers Today and Tomorrow as quick dates, and never a past date', () => {
    createComponent();
    const today = todayIso();

    expect(component['quickDates']).toEqual([
      { label: 'Today', value: today },
      { label: 'Tomorrow', value: addDays(today, 1) },
    ]);
    const dateInput = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('#service-date-input');
    expect(dateInput?.min).toBe(today);
  });

  it('remembers a search it runs, and offers it back as a recent search', async () => {
    createComponent();
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    component['fromField'].select(makeStopSuggestion('stop-a', 'Ikeja'));
    component['toField'].select(makeStopSuggestion('stop-c', 'CMS'));
    const date = addDays(todayIso(), 2);
    component['onServiceDateChange'](date);

    await component['search']();
    createComponent();

    const recent = component['recentSearches']();
    expect(recent.map((row) => `${row.origin}→${row.destination}`)).toEqual(['Ikeja→CMS']);
    expect(component['recentQueryParams'](recent[0])).toEqual({
      origin: 'Ikeja',
      destination: 'CMS',
      service_date: date,
      trip_class: undefined,
    });
    localStorage.removeItem('marketplace.recentSearches');
  });
});
