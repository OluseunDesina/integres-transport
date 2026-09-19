import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ReportIssue } from './report-issue';
import { ReportIssueService } from './report-issue.service';
import { OpenTripsService, type Trip } from '../shared/open-trips.service';

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
    vehicle: {
      id: 'vehicle-1',
      registration_number: 'LAG-123-XY',
      vehicle_type: { id: 'vehicle-type-1', name: 'Standard Bus' },
    },
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

describe('ReportIssue (validator)', () => {
  let fixture: ComponentFixture<ReportIssue>;
  let openTrips: { loadForDate: jasmine.Spy };
  let reports: { report: jasmine.Spy };

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function alerts(): string {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('[role="alert"]')
    )
      .map((node) => node.textContent?.trim() ?? '')
      .join(' | ');
  }

  async function setup(trips: Trip[] = [makeTrip()]): Promise<void> {
    openTrips = { loadForDate: jasmine.createSpy('loadForDate').and.resolveTo(trips) };
    reports = {
      report: jasmine
        .createSpy('report')
        .and.resolveTo({ ok: true, data: { reference: 'INC-XY12ZW' } }),
    };

    await TestBed.configureTestingModule({
      imports: [ReportIssue],
      providers: [
        { provide: OpenTripsService, useValue: openTrips },
        { provide: ReportIssueService, useValue: reports },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ReportIssue);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function fill(values: Record<string, string>): void {
    fixture.componentInstance['form'].patchValue(values);
    fixture.detectChanges();
  }

  it('loads today’s trips into the picker', async () => {
    await setup();

    expect(openTrips.loadForDate).toHaveBeenCalled();
    expect(fixture.componentInstance['tripOptions']().map((o) => o.label)).toContain(
      jasmine.stringMatching(/Ikeja → CMS/) as unknown as string
    );
  });

  it('renders a visible error under every required field on an empty submit', async () => {
    await setup();

    await fixture.componentInstance['submit']();
    fixture.detectChanges();

    const rendered = alerts();
    expect(rendered).toContain('Choose the trip this happened on.');
    expect(rendered).toContain('Choose what kind of problem this is.');
    expect(rendered).toContain('Give the report a short heading.');
    expect(reports.report).not.toHaveBeenCalled();
  });

  it('says what the report will name beyond what was typed', async () => {
    await setup();
    fill({ tripId: 'trip-1' });

    // A form that silently attaches a vehicle registration is a form
    // whose author knows something the user does not.
    expect(text()).toContain('route Ikeja → CMS');
    expect(text()).toContain('vehicle LAG-123-XY');
  });

  it('says only what is true when no bus has been assigned', async () => {
    await setup([makeTrip({ vehicle: null })]);
    fill({ tripId: 'trip-1' });

    expect(text()).toContain('route Ikeja → CMS');
    expect(text()).not.toContain('vehicle');
  });

  it('defaults severity to medium rather than to whatever is first', async () => {
    await setup();

    expect(fixture.componentInstance['form'].controls.severity.value).toBe('medium');
  });

  it('files the report and shows the reference back', async () => {
    await setup();
    fill({ tripId: 'trip-1', category: 'hardware', title: 'Reader is dead' });

    await fixture.componentInstance['submit']();
    fixture.detectChanges();

    expect(reports.report).toHaveBeenCalledWith(
      jasmine.objectContaining({ trip: jasmine.objectContaining({ id: 'trip-1' }) })
    );
    // Something the conductor can quote on the radio.
    expect(text()).toContain('INC-XY12ZW');
  });

  it('surfaces a refusal inline rather than silently doing nothing', async () => {
    await setup();
    fill({ tripId: 'trip-1', category: 'safety', title: 'Door will not close' });
    reports.report.and.resolveTo({ ok: false, status: 403, message: 'Not allowed here.' });

    await fixture.componentInstance['submit']();
    fixture.detectChanges();

    expect(alerts()).toContain('Not allowed here.');
    expect(text()).not.toContain('INC-XY12ZW');
  });

  it('keeps the trip selected when reporting something else', async () => {
    await setup();
    fill({ tripId: 'trip-1', category: 'hardware', title: 'Reader is dead' });
    await fixture.componentInstance['submit']();

    fixture.componentInstance['reportAnother']();
    fixture.detectChanges();

    // Someone who has just found one broken reader is the most likely
    // person to be about to report a second thing on the same bus.
    expect(fixture.componentInstance['form'].controls.tripId.value).toBe('trip-1');
    expect(fixture.componentInstance['form'].controls.title.value).toBe('');
    expect(fixture.componentInstance['form'].controls.severity.value).toBe('medium');
  });

  it('says so when the trip list could not be loaded', async () => {
    openTrips = {
      loadForDate: jasmine.createSpy('loadForDate').and.rejectWith(new Error('offline')),
    };
    await TestBed.configureTestingModule({
      imports: [ReportIssue],
      providers: [
        { provide: OpenTripsService, useValue: openTrips },
        { provide: ReportIssueService, useValue: { report: jasmine.createSpy('report') } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ReportIssue);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(text()).toContain('Could not load today');
  });
});
