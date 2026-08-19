import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { DriverForm } from './driver-form';
import { BusinessOptionsService } from '../../shared/business-options.service';
import { DriverStore, type Driver } from '../../shared/data/store/driver.store';

function makeDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: 'd-1',
    business: 'biz-1',
    name: 'Tunde Bello',
    phone: '',
    license_number: 'DL-000123',
    license_expires_at: null,
    is_active: true,
    compliance_warnings: [],
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeDriverStore {
  items = signal<Driver[]>([]);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
}

class FakeBusinessOptions {
  loadOptions = jasmine
    .createSpy('loadOptions')
    .and.resolveTo([{ value: 'biz-1', label: 'Acme Shuttle Co' }]);
}

async function setup(paramId: string | null, existing: Driver[] = []) {
  const apiClient = {
    GET: jasmine.createSpy('GET'),
    POST: jasmine.createSpy('POST'),
    PATCH: jasmine.createSpy('PATCH'),
  };
  const store = new FakeDriverStore();
  store.items.set(existing);
  const businessOptions = new FakeBusinessOptions();

  await TestBed.configureTestingModule({
    imports: [DriverForm],
    providers: [
      provideRouter([]),
      { provide: API_CLIENT, useValue: apiClient },
      { provide: DriverStore, useValue: store },
      { provide: BusinessOptionsService, useValue: businessOptions },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap(paramId ? { id: paramId } : {}) } },
      },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(DriverForm);
  return { fixture, apiClient, store };
}

describe('DriverForm', () => {
  describe('create mode', () => {
    let fixture: ComponentFixture<DriverForm>;
    let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy; PATCH: jasmine.Spy };

    beforeEach(async () => {
      ({ fixture, apiClient } = await setup(null));
      fixture.detectChanges();
      await fixture.whenStable();
    });

    it('renders the "New driver" heading', () => {
      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('New driver');
    });

    it('does not submit an invalid (missing business/name/license) form', async () => {
      fixture.componentInstance['form'].patchValue({ business: '', name: '', license_number: '' });
      await fixture.componentInstance['onSubmit']();
      expect(apiClient.POST).not.toHaveBeenCalled();
    });

    it('creates a driver and navigates to /drivers on success', async () => {
      apiClient.POST.and.resolveTo({ data: makeDriver() });
      const router = TestBed.inject(Router);
      const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        name: 'Tunde Bello',
        phone: '',
        license_number: 'DL-000123',
        license_expires_at: '',
        is_active: true,
      });

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/drivers/',
        jasmine.objectContaining({
          body: jasmine.objectContaining({ business: 'biz-1', name: 'Tunde Bello' }),
        })
      );
      expect(navigateSpy).toHaveBeenCalledWith(['/drivers']);
    });

    it('shows the server error message on failure (duplicate license)', async () => {
      apiClient.POST.and.resolveTo({
        error: { license_number: ['A driver with this license number already exists.'] },
      });
      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        name: 'Someone',
        phone: '',
        license_number: 'DL-1',
        license_expires_at: '',
        is_active: true,
      });

      await fixture.componentInstance['onSubmit']();
      fixture.detectChanges();

      expect(fixture.componentInstance['errorMessage']()).toBe(
        'A driver with this license number already exists.'
      );
    });
  });

  describe('edit mode', () => {
    it('prefills the form and disables the business field', async () => {
      const driver = makeDriver();
      const { fixture } = await setup('d-1', [driver]);

      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Edit driver');
      expect(fixture.componentInstance['form'].value.name).toBe('Tunde Bello');
      expect(fixture.componentInstance['form'].controls.business.disabled).toBe(true);
    });

    it('patches the driver at its id on submit', async () => {
      const driver = makeDriver();
      const { fixture, apiClient } = await setup('d-1', [driver]);
      fixture.detectChanges();
      await fixture.whenStable();
      apiClient.PATCH.and.resolveTo({ data: driver });
      const router = TestBed.inject(Router);
      spyOn(router, 'navigate').and.resolveTo(true);

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.PATCH).toHaveBeenCalledWith(
        '/api/v1/drivers/{id}/',
        jasmine.objectContaining({ params: { path: { id: 'd-1' } } })
      );
    });

    it('shows a not-found message when the driver is not in the store', async () => {
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
