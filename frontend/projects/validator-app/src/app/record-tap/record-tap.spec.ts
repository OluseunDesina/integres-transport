import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RecordTap } from './record-tap';
import { RecordTapService, type Trip } from './record-tap.service';

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-1',
    schedule: null,
    route: { id: 'route-1', name: 'Gaborone Loop' },
    business: 'biz-1',
    service_date: '2026-09-01',
    scheduled_departure_at: '2026-09-01T08:00:00Z',
    status: 'scheduled',
    status_changed_at: null,
    vehicle: null,
    driver: null,
    booking_mode: 'tap_and_go',
    cancellation_reason: '',
    compliance_warnings: [],
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

async function setup() {
  const recordTapService = jasmine.createSpyObj<RecordTapService>('RecordTapService', [
    'loadTripsForDate',
    'loadRouteStops',
    'recordTap',
  ]);
  recordTapService.loadTripsForDate.and.resolveTo([makeTrip()]);
  recordTapService.loadRouteStops.and.resolveTo([
    { id: 'stop-1', name: 'CBD', sequence: 1 },
    { id: 'stop-2', name: 'Mall', sequence: 2 },
  ]);

  await TestBed.configureTestingModule({
    imports: [RecordTap],
    providers: [{ provide: RecordTapService, useValue: recordTapService }],
  }).compileComponents();

  const fixture = TestBed.createComponent(RecordTap);
  return { fixture, recordTapService };
}

describe('RecordTap', () => {
  let fixture: ComponentFixture<RecordTap>;
  let recordTapService: jasmine.SpyObj<RecordTapService>;

  beforeEach(async () => {
    ({ fixture, recordTapService } = await setup());
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('loads trips for today on init', () => {
    expect(recordTapService.loadTripsForDate).toHaveBeenCalledWith(
      fixture.componentInstance['form'].controls.serviceDate.value
    );
    expect(fixture.componentInstance['trips']().length).toBe(1);
  });

  it('loads the trip route stops when a trip is selected', async () => {
    fixture.componentInstance['form'].controls.tripId.setValue('trip-1');
    await fixture.whenStable();

    expect(recordTapService.loadRouteStops).toHaveBeenCalledWith('biz-1', 'route-1');
    expect(fixture.componentInstance['stops']().length).toBe(2);
  });

  it('resets the stop selection when the trip changes', async () => {
    fixture.componentInstance['form'].controls.tripId.setValue('trip-1');
    await fixture.whenStable();
    fixture.componentInstance['form'].controls.stopId.setValue('stop-1');

    fixture.componentInstance['form'].controls.tripId.setValue('');
    await fixture.whenStable();

    expect(fixture.componentInstance['form'].controls.stopId.value).toBe('');
    expect(fixture.componentInstance['stops']()).toEqual([]);
  });

  it('defaults to a board tap and toggles to alight', () => {
    expect(fixture.componentInstance['tapType']()).toBe('board');
    fixture.componentInstance['setTapType']('alight');
    expect(fixture.componentInstance['tapType']()).toBe('alight');
  });

  it('does not submit an invalid (missing fields) form', async () => {
    await fixture.componentInstance['onSubmit']();
    expect(recordTapService.recordTap).not.toHaveBeenCalled();
  });

  it('submits the selected trip/token/tap type/stop and shows the result', async () => {
    recordTapService.recordTap.and.resolveTo({
      ok: true,
      data: {
        id: 'tap-1',
        trip: 'trip-1',
        tap_type: 'board',
        stop: 'stop-1',
        tapped_at: '2026-09-01T08:00:00Z',
        journey: { id: 'journey-1', status: 'open', amount: null, currency: '' },
      },
    });
    const component = fixture.componentInstance;
    component['form'].controls.tripId.setValue('trip-1');
    await fixture.whenStable();
    component['form'].patchValue({ token: 'scanned-token', stopId: 'stop-1' });

    await component['onSubmit']();

    expect(recordTapService.recordTap).toHaveBeenCalledWith({
      tripId: 'trip-1',
      token: 'scanned-token',
      tapType: 'board',
      stopId: 'stop-1',
    });
    expect(component['result']()).toEqual({
      ok: true,
      data: jasmine.objectContaining({ id: 'tap-1' }),
    });
    // Token is cleared for the next passenger; trip/stop stay selected.
    expect(component['form'].controls.token.value).toBe('');
    expect(component['form'].controls.tripId.value).toBe('trip-1');
  });

  it('shows the error message when the API call fails', async () => {
    recordTapService.recordTap.and.resolveTo({
      ok: false,
      status: 409,
      message: 'This passenger already has an open tap-and-go journey.',
    });
    const component = fixture.componentInstance;
    component['form'].controls.tripId.setValue('trip-1');
    await fixture.whenStable();
    component['form'].patchValue({ token: 'scanned-token', stopId: 'stop-1' });

    await component['onSubmit']();

    expect(component['result']()).toEqual({
      ok: false,
      message: 'This passenger already has an open tap-and-go journey.',
    });
  });
});
