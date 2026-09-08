import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { VehicleTypeForm } from './vehicle-type-form';
import { BusinessOptionsService } from '../../shared/business-options.service';
import { VehicleTypeStore, type VehicleType } from '../../shared/data/store/vehicle-type.store';

function makeVehicleType(overrides: Partial<VehicleType> = {}): VehicleType {
  return {
    id: 'vt-1',
    business: 'biz-1',
    name: '33-seater coaster',
    capacity: 33,
    trip_class: 'standard',
    is_active: true,
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeVehicleTypeStore {
  items = signal<VehicleType[]>([]);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  /** Mirrors `ListStore.findByIdPaged`: match the loaded rows, else
   * null. The component must never read `items()` and `.find()` for
   * itself — doing so is what made any record past the store's
   * current page report "not found" on a refresh. */
  findById = jasmine
    .createSpy('findById')
    .and.callFake((id: string) =>
      Promise.resolve(this.items().find((item) => item.id === id) ?? null)
    );
}

class FakeBusinessOptions {
  loadOptions = jasmine
    .createSpy('loadOptions')
    .and.resolveTo([{ value: 'biz-1', label: 'Acme Shuttle Co' }]);
}

async function setup(paramId: string | null, existing: VehicleType[] = []) {
  const apiClient = {
    GET: jasmine.createSpy('GET'),
    POST: jasmine.createSpy('POST'),
    PATCH: jasmine.createSpy('PATCH'),
  };
  const store = new FakeVehicleTypeStore();
  store.items.set(existing);
  const businessOptions = new FakeBusinessOptions();

  await TestBed.configureTestingModule({
    imports: [VehicleTypeForm],
    providers: [
      provideRouter([]),
      { provide: API_CLIENT, useValue: apiClient },
      { provide: VehicleTypeStore, useValue: store },
      { provide: BusinessOptionsService, useValue: businessOptions },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            paramMap: convertToParamMap(paramId ? { id: paramId } : {}),
          },
        },
      },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(VehicleTypeForm);
  return { fixture, apiClient, store };
}

describe('VehicleTypeForm', () => {
  describe('create mode', () => {
    let fixture: ComponentFixture<VehicleTypeForm>;
    let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy; PATCH: jasmine.Spy };

    beforeEach(async () => {
      ({ fixture, apiClient } = await setup(null));
      fixture.detectChanges();
      await fixture.whenStable();
    });

    it('renders the "New vehicle type" heading', () => {
      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('New vehicle type');
    });

    // docs/specs/15-trip-classes.md. Asserted on *rendered* output, not
    // just on the request: docs/self-check-2026-08-26-spec11.md records
    // that ui-select shows nothing at all unless the parent binds both
    // [invalid] and [errorMessage], and a form that binds neither
    // passes a "the POST didn't happen" test while showing the operator
    // no reason why.
    describe('service class', () => {
      it('renders every class as an option', () => {
        // The control name is on the `ui-select` host; the real
        // `<select>` is inside it.
        const select: HTMLSelectElement = fixture.nativeElement.querySelector(
          'ui-select[formcontrolname="trip_class"] select'
        );
        const labels = Array.from(select.options).map((option) => option.textContent?.trim());

        expect(labels).toEqual(['Premium', 'Exclusive', 'Standard', 'Mini']);
      });

      it('defaults to standard, the class every existing vehicle type backfilled to', () => {
        expect(fixture.componentInstance['form'].controls.trip_class.value).toBe('standard');
      });

      it('renders a validation message when the class is cleared and submitted', async () => {
        fixture.componentInstance['form'].controls.trip_class.setValue(
          '' as unknown as 'standard'
        );

        await fixture.componentInstance['onSubmit']();
        fixture.detectChanges();

        expect(apiClient.POST).not.toHaveBeenCalled();
        expect(fixture.nativeElement.textContent).toContain('This field is required.');
      });

      it('sends the chosen class when creating', async () => {
        apiClient.POST.and.resolveTo({ data: makeVehicleType() });
        spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        fixture.componentInstance['form'].patchValue({
          business: 'biz-1',
          name: 'Executive coach',
          capacity: 20,
          trip_class: 'premium',
        });

        await fixture.componentInstance['onSubmit']();

        expect(apiClient.POST).toHaveBeenCalledWith(
          '/api/v1/vehicle-types/',
          jasmine.objectContaining({
            body: jasmine.objectContaining({ trip_class: 'premium' }),
          })
        );
      });
    });

    it('does not submit an invalid (missing business/name) form', async () => {
      fixture.componentInstance['form'].patchValue({ business: '', name: '' });
      await fixture.componentInstance['onSubmit']();
      expect(apiClient.POST).not.toHaveBeenCalled();
    });

    it('creates a vehicle type and navigates to /vehicle-types on success', async () => {
      apiClient.POST.and.resolveTo({ data: makeVehicleType() });
      const router = TestBed.inject(Router);
      const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        name: '33-seater coaster',
        capacity: 33,
        trip_class: 'standard',
      });

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/vehicle-types/',
        jasmine.objectContaining({
          body: jasmine.objectContaining({
            business: 'biz-1',
            name: '33-seater coaster',
          }),
        }),
      );
      expect(navigateSpy).toHaveBeenCalledWith(['/vehicle-types']);
    });

    it('shows the server error message on failure', async () => {
      apiClient.POST.and.resolveTo({
        error: { business: ['Unknown business.'] },
      });
      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        name: 'X',
        capacity: 1,
        trip_class: 'standard',
      });

      await fixture.componentInstance['onSubmit']();
      fixture.detectChanges();

      expect(fixture.componentInstance['errorMessage']()).toBe('Unknown business.');
    });
  });

  describe('edit mode', () => {
    it('prefills the form and disables the business field', async () => {
      const vehicleType = makeVehicleType();
      const { fixture } = await setup('vt-1', [vehicleType]);

      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Edit vehicle type');
      expect(fixture.componentInstance['form'].value.name).toBe('33-seater coaster');
      expect(fixture.componentInstance['form'].controls.business.disabled).toBe(true);
    });

    it('patches the vehicle type at its id on submit', async () => {
      const vehicleType = makeVehicleType();
      const { fixture, apiClient } = await setup('vt-1', [vehicleType]);
      fixture.detectChanges();
      await fixture.whenStable();
      apiClient.PATCH.and.resolveTo({ data: vehicleType });
      const router = TestBed.inject(Router);
      spyOn(router, 'navigate').and.resolveTo(true);

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.PATCH).toHaveBeenCalledWith(
        '/api/v1/vehicle-types/{id}/',
        jasmine.objectContaining({ params: { path: { id: 'vt-1' } } }),
      );
    });

    it('shows a not-found message when the vehicle type is not in the store', async () => {
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
