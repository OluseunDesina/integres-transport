import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { expectColumnVisibilityParity } from '@shared-ui';

import { MyReports } from './my-reports';
import {
  IncidentReportStore,
  type PassengerIncident,
} from '../shared/data/store/incident-report.store';

function makeReport(overrides: Partial<PassengerIncident> = {}): PassengerIncident {
  return {
    id: 'inc-1',
    reference: 'INC-AB12CD',
    title: 'Card reader would not take my card',
    description: 'No lights on the reader at all.',
    category: 'hardware',
    status: 'open',
    created_at: '2026-09-01T07:00:00Z',
    resolved_at: null,
    ...overrides,
  };
}

class FakeIncidentReportStore {
  items = signal<PassengerIncident[]>([]);
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

describe('MyReports', () => {
  let fixture: ComponentFixture<MyReports>;
  let store: FakeIncidentReportStore;
  let navigate: jasmine.Spy;

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  async function setup(queryParams: Record<string, string> = {}): Promise<void> {
    store = new FakeIncidentReportStore();

    await TestBed.configureTestingModule({
      imports: [MyReports],
      providers: [
        { provide: IncidentReportStore, useValue: store },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap(queryParams) } },
        },
      ],
    }).compileComponents();

    navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    fixture = TestBed.createComponent(MyReports);
    fixture.detectChanges();
  }

  it('loads the passenger’s own reports on init', async () => {
    await setup();

    expect(store.getAll).toHaveBeenCalled();
  });

  it('shows the empty state, with a way out of it', async () => {
    await setup();
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(text()).toContain('No reports yet');
    expect(text()).toContain('Report an issue');
  });

  it('distinguishes a load failure from an empty list', async () => {
    await setup();
    store.error.set('Failed to load your reports.');
    fixture.detectChanges();

    expect(text()).toContain('Failed to load your reports.');
    // Not the empty state: "you have never reported anything" and "we
    // could not find out" are different facts.
    expect(text()).not.toContain('No reports yet');
  });

  it('renders each report with a status label, never colour alone', async () => {
    await setup();
    store.items.set([makeReport({ status: 'investigating' })]);
    fixture.detectChanges();

    expect(text()).toContain('INC-AB12CD');
    // The passenger wording, not the operator's "Investigating".
    expect(text()).toContain('Being investigated');
  });

  it('leads with the category and the passenger’s own words, not the derived title', async () => {
    await setup();
    store.items.set([
      makeReport({ title: 'Passenger report: Hardware', description: 'No lights at all.' }),
    ]);
    fixture.detectChanges();

    // `passenger_report_title` derives "Passenger report: <Category>"
    // for the operator queue's first column. Rendering it here put the
    // category on the row twice and prefixed it with the one fact this
    // whole screen already establishes.
    expect(text()).not.toContain('Passenger report:');
    expect(text()).toContain('Card reader or ticket machine');
    expect(text()).toContain('No lights at all.');
  });

  it('renders passenger wording for a status the operator calls "Open"', async () => {
    await setup();
    store.items.set([makeReport({ status: 'open' })]);
    fixture.detectChanges();

    // "Open" is operator vocabulary for "nobody has looked yet", which
    // to the person waiting reads as nothing having happened.
    expect(text()).toContain('Received');
    expect(text()).not.toContain('Open');
  });

  it('shows when a report was resolved, and says nothing when it is not', async () => {
    await setup();
    store.items.set([makeReport({ status: 'resolved', resolved_at: '2026-09-03T09:00:00Z' })]);
    fixture.detectChanges();
    expect(text()).toContain('Resolved');
    expect(text()).toContain('3 Sep 2026');

    store.items.set([makeReport()]);
    fixture.detectChanges();
    expect(text()).not.toContain('3 Sep 2026');
  });

  it('says something rather than nothing when a report carries no description', async () => {
    await setup();
    store.items.set([makeReport({ category: 'gps', description: '' })]);
    fixture.detectChanges();

    expect(text()).toContain('Location tracking');
    expect(text()).toContain('—');
  });

  it('keeps every hidden column paired with its header', async () => {
    await setup();
    store.items.set([makeReport()]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'my-reports');
  });

  it('renders no table at all while loading, so there are no skeleton cells to keep paired', async () => {
    await setup();
    store.items.set([makeReport()]);
    store.loading.set(true);
    fixture.detectChanges();

    // `docs/frontend-patterns.md` says to assert parity in the loading
    // state too. That is a client-admin rule: its lists write their own
    // skeleton `<td>`s, which is the third place a visibility class has
    // to be repeated. This app's lists hand `[loading]` to `ui-table`,
    // which swaps the whole table for a message — so there is no third
    // copy to get wrong, and asserting it here would be asserting
    // nothing. Pinned as behaviour rather than left implicit: the day
    // this screen grows its own skeleton rows, this test fails and says
    // to add the parity check.
    expect(fixture.nativeElement.querySelector('table')).toBeNull();
  });

  it('confirms a report that was just filed, by reference', async () => {
    await setup({ filed: 'INC-ZZ99YY' });

    // Read from the URL rather than router state so a reload still
    // shows it — the reference is the only thing this screen gives a
    // passenger to quote.
    expect(text()).toContain('INC-ZZ99YY');
  });

  it('says nothing about a filing when the passenger just navigated here', async () => {
    await setup();

    expect(text()).not.toContain('your report is with the operator');
  });

  it('sends the passenger to the report form', async () => {
    await setup();
    await fixture.componentInstance['reportIssue']();

    expect(navigate).toHaveBeenCalledWith(['/report-issue']);
  });
});
