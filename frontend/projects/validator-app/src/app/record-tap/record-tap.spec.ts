import { ComponentFixture, TestBed } from '@angular/core/testing';

import {
  ValidateTicketService,
  type TicketValidationResult,
} from '../validate-ticket/validate-ticket.service';
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
    // docs/specs/16-operational-analytics.md slice 1 — null
    // on every Trip that has not departed, which is most of them.
    actual_departure_at: null,
    actual_arrival_at: null,
    vehicle: null,
    driver: null,
    booking_mode: 'open_seating',
    fare_collection_mode: 'pay_as_you_go',
    trip_class: 'standard',
    cancellation_reason: '',
    compliance_warnings: [],
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

const PREPAID_TRIP = makeTrip({
  id: 'trip-prepaid',
  fare_collection_mode: 'prepaid',
  booking_mode: 'reservation',
});

function makeValidationResult(
  overrides: Partial<TicketValidationResult> = {}
): TicketValidationResult {
  return {
    status: 'boarded',
    passenger_name: 'Ada Obi',
    seat_number: '4A',
    from_stop: 'CBD',
    to_stop: 'Mall',
    trip_departure_at: '2026-09-01T08:00:00Z',
    booking_status: 'completed',
    ...overrides,
  };
}

async function setup() {
  const recordTapService = jasmine.createSpyObj<RecordTapService>('RecordTapService', [
    'loadTripsForDate',
    'loadRouteStops',
    'recordTap',
  ]);
  recordTapService.loadTripsForDate.and.resolveTo([makeTrip(), PREPAID_TRIP]);
  recordTapService.loadRouteStops.and.resolveTo([
    { id: 'stop-1', name: 'CBD', sequence: 1 },
    { id: 'stop-2', name: 'Mall', sequence: 2 },
  ]);
  const validateTicketService = jasmine.createSpyObj<ValidateTicketService>(
    'ValidateTicketService',
    ['loadTripsForDate', 'validateTicket', 'validateCredential']
  );

  await TestBed.configureTestingModule({
    imports: [RecordTap],
    providers: [
      { provide: RecordTapService, useValue: recordTapService },
      { provide: ValidateTicketService, useValue: validateTicketService },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(RecordTap);
  return { fixture, recordTapService, validateTicketService };
}

describe('RecordTap', () => {
  let fixture: ComponentFixture<RecordTap>;
  let recordTapService: jasmine.SpyObj<RecordTapService>;
  let validateTicketService: jasmine.SpyObj<ValidateTicketService>;

  beforeEach(async () => {
    ({ fixture, recordTapService, validateTicketService } = await setup());
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('loads trips for today on init', () => {
    expect(recordTapService.loadTripsForDate).toHaveBeenCalledWith(
      fixture.componentInstance['form'].controls.serviceDate.value
    );
    expect(fixture.componentInstance['trips']().length).toBe(2);
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

  it('shows the selected trip detail and its fare collection mode', async () => {
    // Rendered, not read off the signal: `selectedTrip` was a computed
    // over a plain form-control value, which depends on no signal and
    // so froze on "nothing selected" in the browser. A signal-level
    // assertion passes against that bug; this one does not.
    fixture.componentInstance['form'].controls.tripId.setValue('trip-1');
    await fixture.whenStable();
    fixture.detectChanges();

    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('Gaborone Loop');
    expect(text).toContain('Pay as you go');
    // Words, not enum values — this line rendered "scheduled" and a raw
    // ISO service date until slice 6b.
    expect(text).not.toContain('scheduled');
    expect(text).toContain('Scheduled');
  });

  it('defaults to a board tap and toggles to alight', () => {
    expect(fixture.componentInstance['tapType']()).toBe('board');
    fixture.componentInstance['setTapType']('alight');
    expect(fixture.componentInstance['tapType']()).toBe('alight');
  });

  /**
   * The board/alight control was a `role="radiogroup"` div wrapping two
   * `ui-button`s with `aria-pressed`: it announced as a radio group and
   * behaved as two independent toggle buttons, with no arrow-key
   * selection and two tab stops.
   */
  it('offers board and alight as one real radio group', async () => {
    fixture.componentInstance['form'].controls.tripId.setValue('trip-1');
    await fixture.whenStable();
    fixture.detectChanges();

    const radios = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>(
        'input[type="radio"]'
      )
    );
    expect(radios.map((r) => r.value)).toEqual(['board', 'alight']);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    // No leftover toggle buttons pretending to be radios.
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[role="radiogroup"] ui-button')
    ).toBeNull();
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
      kind: 'journey',
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

  // --- prepaid trips: the same tap boards a ticket ---------------------------

  describe('on a prepaid trip', () => {
    let component: RecordTap;

    beforeEach(async () => {
      component = fixture.componentInstance;
      component['form'].controls.tripId.setValue('trip-prepaid');
      await fixture.whenStable();
      fixture.detectChanges();
    });

    it('hides the tap type and stop controls, which have no meaning here', () => {
      const text: string = fixture.nativeElement.textContent;
      expect(text).not.toContain('Tap type');
      expect(fixture.nativeElement.querySelectorAll('ui-select').length).toBe(1); // trip only
      expect(text).toContain('Prepaid');
    });

    it('does not ask the backend for stops it will not offer', () => {
      expect(recordTapService.loadRouteStops).not.toHaveBeenCalled();
    });

    it('submits with no stop selected — the required stop is disabled, not just hidden', async () => {
      validateTicketService.validateCredential.and.resolveTo({
        ok: true,
        data: makeValidationResult(),
      });
      component['form'].patchValue({ token: 'scanned-token' });

      await component['onSubmit']();

      expect(validateTicketService.validateCredential).toHaveBeenCalledWith({
        tripId: 'trip-prepaid',
        token: 'scanned-token',
      });
      expect(recordTapService.recordTap).not.toHaveBeenCalled();
      expect(component['result']()).toEqual({
        ok: true,
        kind: 'ticket',
        data: jasmine.objectContaining({ passenger_name: 'Ada Obi' }),
      });
      expect(component['form'].controls.token.value).toBe('');
    });

    it('renders the boarded passenger rather than a journey', async () => {
      validateTicketService.validateCredential.and.resolveTo({
        ok: true,
        data: makeValidationResult({ seat_number: null }),
      });
      component['form'].patchValue({ token: 'scanned-token' });

      await component['onSubmit']();
      fixture.detectChanges();

      const text: string = fixture.nativeElement.textContent;
      expect(text).toContain('Ada Obi');
      expect(text).toContain('CBD');
      // An open-seating ticket has no seat, so the label must not appear
      // at all rather than trailing an empty value.
      expect(text).not.toContain('seat');
    });

    it('shows the error message when no ticket matches the credential', async () => {
      validateTicketService.validateCredential.and.resolveTo({
        ok: false,
        status: 404,
        message: 'No ticket was found for this credential on this trip.',
      });
      component['form'].patchValue({ token: 'scanned-token' });

      await component['onSubmit']();

      expect(component['result']()).toEqual({
        ok: false,
        message: 'No ticket was found for this credential on this trip.',
      });
    });

    it('re-enables the stop control when switching back to a pay-as-you-go trip', async () => {
      expect(component['form'].controls.stopId.disabled).toBeTrue();

      component['form'].controls.tripId.setValue('trip-1');
      await fixture.whenStable();

      expect(component['form'].controls.stopId.disabled).toBeFalse();
    });
  });
});
