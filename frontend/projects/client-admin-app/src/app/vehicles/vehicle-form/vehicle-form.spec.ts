import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { VehicleForm } from './vehicle-form';
import { BusinessOptionsService } from '../../shared/business-options.service';
import { VehicleStore, type Vehicle } from '../../shared/data/store/vehicle.store';

function makeVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    id: 'v-1',
    business: 'biz-1',
    vehicle_type: 'vt-1',
    registration_number: 'LAG-123-XY',
    insurance_expires_at: null,
    roadworthiness_expires_at: null,
    is_active: true,
    compliance_warnings: [],
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeVehicleStore {
  items = signal<Vehicle[]>([]);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
}

class FakeBusinessOptions {
  loadOptions = jasmine
    .createSpy('loadOptions')
    .and.resolveTo([{ value: 'biz-1', label: 'Acme Shuttle Co' }]);
}

async function setup(paramId: string | null, existing: Vehicle[] = []) {
  const apiClient = {
    GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
    POST: jasmine.createSpy('POST'),
    PATCH: jasmine.createSpy('PATCH'),
  };
  const store = new FakeVehicleStore();
  store.items.set(existing);
  const businessOptions = new FakeBusinessOptions();

  await TestBed.configureTestingModule({
    imports: [VehicleForm],
    providers: [
      provideRouter([]),
      { provide: API_CLIENT, useValue: apiClient },
      { provide: VehicleStore, useValue: store },
      { provide: BusinessOptionsService, useValue: businessOptions },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap(paramId ? { id: paramId } : {}) } },
      },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(VehicleForm);
  return { fixture, apiClient, store };
}

describe('VehicleForm', () => {
  describe('create mode', () => {
    let fixture: ComponentFixture<VehicleForm>;
    let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy; PATCH: jasmine.Spy };

    beforeEach(async () => {
      ({ fixture, apiClient } = await setup(null));
      fixture.detectChanges();
      await fixture.whenStable();
    });

    it('renders the "New vehicle" heading', () => {
      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('New vehicle');
    });

    it('does not submit an invalid (missing fields) form', async () => {
      await fixture.componentInstance['onSubmit']();
      expect(apiClient.POST).not.toHaveBeenCalled();
    });

    it('loads vehicle type options scoped to the chosen Business', async () => {
      apiClient.GET.calls.reset();
      fixture.componentInstance['form'].controls.business.setValue('biz-1');
      await fixture.whenStable();

      expect(apiClient.GET).toHaveBeenCalledWith(
        '/api/v1/vehicle-types/',
        jasmine.objectContaining({
          params: { query: { limit: 100, offset: 0, business: 'biz-1' } },
        })
      );
    });

    it('creates a vehicle and navigates to /vehicles on success', async () => {
      apiClient.POST.and.resolveTo({ data: makeVehicle() });
      const router = TestBed.inject(Router);
      const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        vehicle_type: 'vt-1',
        registration_number: 'LAG-123-XY',
        insurance_expires_at: '',
        roadworthiness_expires_at: '',
        is_active: true,
      });

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/vehicles/',
        jasmine.objectContaining({
          body: jasmine.objectContaining({ business: 'biz-1', vehicle_type: 'vt-1' }),
        })
      );
      expect(navigateSpy).toHaveBeenCalledWith(['/vehicles']);
    });

    it('shows the server error message on failure (vehicle type mismatch)', async () => {
      apiClient.POST.and.resolveTo({
        error: { vehicle_type: ['This vehicle type belongs to a different Business.'] },
      });
      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        vehicle_type: 'vt-2',
        registration_number: 'LAG-999-XY',
        insurance_expires_at: '',
        roadworthiness_expires_at: '',
        is_active: true,
      });

      await fixture.componentInstance['onSubmit']();
      fixture.detectChanges();

      expect(fixture.componentInstance['errorMessage']()).toBe(
        'This vehicle type belongs to a different Business.'
      );
    });
  });

  describe('edit mode', () => {
    it('prefills the form and disables business and vehicle_type', async () => {
      const vehicle = makeVehicle();
      const { fixture } = await setup('v-1', [vehicle]);

      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Edit vehicle');
      expect(fixture.componentInstance['form'].value.registration_number).toBe('LAG-123-XY');
      expect(fixture.componentInstance['form'].controls.business.disabled).toBe(true);
      expect(fixture.componentInstance['form'].controls.vehicle_type.disabled).toBe(true);
    });

    it('patches the vehicle at its id on submit', async () => {
      const vehicle = makeVehicle();
      const { fixture, apiClient } = await setup('v-1', [vehicle]);
      fixture.detectChanges();
      await fixture.whenStable();
      apiClient.PATCH.and.resolveTo({ data: vehicle });
      const router = TestBed.inject(Router);
      spyOn(router, 'navigate').and.resolveTo(true);

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.PATCH).toHaveBeenCalledWith(
        '/api/v1/vehicles/{id}/',
        jasmine.objectContaining({ params: { path: { id: 'v-1' } } })
      );
    });

    it('shows a not-found message when the vehicle is not in the store', async () => {
      const { fixture, store } = await setup('missing-id', []);
      store.getAll.and.callFake(() => {
        store.items.set([]);
        return Promise.resolve();
      });

      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain("couldn't be found");
    });
  });
});
