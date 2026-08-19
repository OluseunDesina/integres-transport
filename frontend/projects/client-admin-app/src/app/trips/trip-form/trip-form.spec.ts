import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { TripForm } from './trip-form';
import { BusinessOptionsService } from '../../shared/business-options.service';

class FakeBusinessOptions {
  loadOptions = jasmine
    .createSpy('loadOptions')
    .and.resolveTo([{ value: 'biz-1', label: 'Acme Shuttle Co' }]);
}

async function setup() {
  const apiClient = {
    GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
    POST: jasmine.createSpy('POST'),
    PATCH: jasmine.createSpy('PATCH'),
  };
  const businessOptions = new FakeBusinessOptions();

  await TestBed.configureTestingModule({
    imports: [TripForm],
    providers: [
      provideRouter([]),
      { provide: API_CLIENT, useValue: apiClient },
      { provide: BusinessOptionsService, useValue: businessOptions },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(TripForm);
  return { fixture, apiClient };
}

describe('TripForm', () => {
  let fixture: ComponentFixture<TripForm>;
  let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy; PATCH: jasmine.Spy };

  beforeEach(async () => {
    ({ fixture, apiClient } = await setup());
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('renders the "New trip" heading', () => {
    expect(fixture.nativeElement.querySelector('h1').textContent).toContain('New trip');
  });

  it('does not submit an invalid (missing fields) form', async () => {
    await fixture.componentInstance['onSubmit']();
    expect(apiClient.POST).not.toHaveBeenCalled();
  });

  it('re-fetches route, vehicle, and driver options together on Business change', async () => {
    apiClient.GET.calls.reset();
    fixture.componentInstance['form'].controls.business.setValue('biz-1');
    await fixture.whenStable();

    const calledPaths = apiClient.GET.calls.allArgs().map((args) => args[0]);
    expect(calledPaths).toContain('/api/v1/routes/');
    expect(calledPaths).toContain('/api/v1/vehicles/');
    expect(calledPaths).toContain('/api/v1/drivers/');
    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/vehicles/',
      jasmine.objectContaining({
        params: { query: { limit: 100, offset: 0, business: 'biz-1' } },
      })
    );
  });

  it('creates a manual trip and never sends a schedule field, then navigates to /trips', async () => {
    apiClient.POST.and.resolveTo({
      data: {
        id: 'trip-1',
        schedule: null,
        route: { id: 'route-1', name: 'Ikeja Express' },
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
      },
    });
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

    fixture.componentInstance['form'].setValue({
      business: 'biz-1',
      route: 'route-1',
      service_date: '2026-09-01',
      departure_time: '08:00',
      vehicle: '',
      driver: '',
    });

    await fixture.componentInstance['onSubmit']();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/trips/',
      jasmine.objectContaining({
        body: {
          route: 'route-1',
          service_date: '2026-09-01',
          departure_time: '08:00',
          vehicle: null,
          driver: null,
        },
      })
    );
    expect(navigateSpy).toHaveBeenCalledWith(['/trips']);
  });

  it('shows the server error message on failure (cross-business vehicle)', async () => {
    apiClient.POST.and.resolveTo({
      error: { vehicle: ['This vehicle belongs to a different Business.'] },
    });
    fixture.componentInstance['form'].setValue({
      business: 'biz-1',
      route: 'route-1',
      service_date: '2026-09-01',
      departure_time: '08:00',
      vehicle: 'v-2',
      driver: '',
    });

    await fixture.componentInstance['onSubmit']();
    fixture.detectChanges();

    expect(fixture.componentInstance['errorMessage']()).toBe(
      'This vehicle belongs to a different Business.'
    );
  });
});
