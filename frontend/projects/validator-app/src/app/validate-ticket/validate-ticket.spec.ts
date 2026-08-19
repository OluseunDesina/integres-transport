import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ValidateTicket } from './validate-ticket';
import { ValidateTicketService, type Trip } from './validate-ticket.service';

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-1',
    schedule: null,
    route: { id: 'route-1', name: 'Ikeja → CMS' },
    business: 'biz-1',
    service_date: '2026-09-01',
    scheduled_departure_at: '2026-09-01T08:00:00Z',
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

async function setup() {
  const validateTicketService = jasmine.createSpyObj<ValidateTicketService>('ValidateTicketService', [
    'loadTripsForDate',
    'validateTicket',
  ]);
  validateTicketService.loadTripsForDate.and.resolveTo([makeTrip()]);

  await TestBed.configureTestingModule({
    imports: [ValidateTicket],
    providers: [{ provide: ValidateTicketService, useValue: validateTicketService }],
  }).compileComponents();

  const fixture = TestBed.createComponent(ValidateTicket);
  return { fixture, validateTicketService };
}

describe('ValidateTicket', () => {
  let fixture: ComponentFixture<ValidateTicket>;
  let validateTicketService: jasmine.SpyObj<ValidateTicketService>;

  beforeEach(async () => {
    ({ fixture, validateTicketService } = await setup());
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('loads trips for today on init', () => {
    expect(validateTicketService.loadTripsForDate).toHaveBeenCalledWith(
      fixture.componentInstance['form'].controls.serviceDate.value
    );
    expect(fixture.componentInstance['trips']().length).toBe(1);
  });

  it('reloads trips and clears the trip selection when the service date changes', async () => {
    fixture.componentInstance['form'].controls.tripId.setValue('trip-1');
    validateTicketService.loadTripsForDate.calls.reset();
    validateTicketService.loadTripsForDate.and.resolveTo([]);

    fixture.componentInstance['form'].controls.serviceDate.setValue('2026-09-02');
    await fixture.whenStable();

    expect(validateTicketService.loadTripsForDate).toHaveBeenCalledWith('2026-09-02');
    expect(fixture.componentInstance['form'].controls.tripId.value).toBe('');
  });

  it('does not submit an invalid (missing fields) form', async () => {
    await fixture.componentInstance['onSubmit']();
    expect(validateTicketService.validateTicket).not.toHaveBeenCalled();
  });

  it('submits the selected trip and payload and shows the result', async () => {
    validateTicketService.validateTicket.and.resolveTo({
      ok: true,
      data: {
        status: 'boarded',
        passenger_name: 'Ada Obi',
        seat_number: '1A',
        from_stop: 'Ikeja',
        to_stop: 'CMS',
        trip_departure_at: '2026-09-01T06:30:00Z',
      },
    });
    const component = fixture.componentInstance;
    component['form'].controls.tripId.setValue('trip-1');
    component['form'].controls.payload.setValue('signed-payload');
    await fixture.whenStable();

    await component['onSubmit']();

    expect(validateTicketService.validateTicket).toHaveBeenCalledWith({
      tripId: 'trip-1',
      payload: 'signed-payload',
    });
    expect(component['result']()).toEqual({
      ok: true,
      data: jasmine.objectContaining({ status: 'boarded', passenger_name: 'Ada Obi' }),
    });
    // Payload is cleared for the next passenger; trip stays selected.
    expect(component['form'].controls.payload.value).toBe('');
    expect(component['form'].controls.tripId.value).toBe('trip-1');
  });

  it('shows the error message when the API call fails', async () => {
    validateTicketService.validateTicket.and.resolveTo({
      ok: false,
      status: 409,
      message: 'This ticket has already been boarded.',
    });
    const component = fixture.componentInstance;
    component['form'].controls.tripId.setValue('trip-1');
    component['form'].controls.payload.setValue('signed-payload');
    await fixture.whenStable();

    await component['onSubmit']();

    expect(component['result']()).toEqual({
      ok: false,
      message: 'This ticket has already been boarded.',
    });
  });
});
