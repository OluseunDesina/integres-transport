import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { StopForm } from './stop-form';
import { BusinessOptionsService } from '../../shared/business-options.service';
import { StopStore, type Stop } from '../../shared/data/store/stop.store';

function makeStop(overrides: Partial<Stop> = {}): Stop {
  return {
    id: 'stop-1',
    business: 'biz-1',
    name: 'Ikeja Bus Park',
    address: '12 Awolowo Rd',
    latitude: null,
    longitude: null,
    is_active: true,
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeStopStore {
  items = signal<Stop[]>([]);
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

async function setup(paramId: string | null, existing: Stop[] = []) {
  const apiClient = {
    GET: jasmine.createSpy('GET'),
    POST: jasmine.createSpy('POST'),
    PATCH: jasmine.createSpy('PATCH'),
  };
  const store = new FakeStopStore();
  store.items.set(existing);
  const businessOptions = new FakeBusinessOptions();

  await TestBed.configureTestingModule({
    imports: [StopForm],
    providers: [
      provideRouter([]),
      { provide: API_CLIENT, useValue: apiClient },
      { provide: StopStore, useValue: store },
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

  const fixture = TestBed.createComponent(StopForm);
  return { fixture, apiClient, store };
}

describe('StopForm', () => {
  describe('create mode', () => {
    let fixture: ComponentFixture<StopForm>;
    let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy; PATCH: jasmine.Spy };

    beforeEach(async () => {
      ({ fixture, apiClient } = await setup(null));
      fixture.detectChanges();
      await fixture.whenStable();
    });

    it('renders the "New stop" heading', () => {
      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('New stop');
    });

    it('does not submit an invalid (missing business/name) form', async () => {
      await fixture.componentInstance['onSubmit']();
      expect(apiClient.POST).not.toHaveBeenCalled();
    });

    it('creates a stop and navigates to /stops on success', async () => {
      apiClient.POST.and.resolveTo({ data: makeStop() });
      const router = TestBed.inject(Router);
      const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        name: 'Ikeja Bus Park',
        address: '12 Awolowo Rd',
        latitude: '',
        longitude: '',
      });

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/stops/',
        jasmine.objectContaining({
          body: jasmine.objectContaining({
            business: 'biz-1',
            name: 'Ikeja Bus Park',
          }),
        }),
      );
      expect(navigateSpy).toHaveBeenCalledWith(['/stops']);
    });

    it('shows the server error message on failure (missing location)', async () => {
      apiClient.POST.and.resolveTo({
        error: {
          non_field_errors: ['Provide an address or both latitude and longitude.'],
        },
      });
      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        name: 'Nowhere',
        address: '',
        latitude: '',
        longitude: '',
      });

      await fixture.componentInstance['onSubmit']();
      fixture.detectChanges();

      expect(fixture.componentInstance['errorMessage']()).toBe(
        'Provide an address or both latitude and longitude.',
      );
    });
  });

  describe('edit mode', () => {
    it('prefills the form and disables the business field', async () => {
      const stop = makeStop();
      const { fixture } = await setup('stop-1', [stop]);

      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Edit stop');
      expect(fixture.componentInstance['form'].value.name).toBe('Ikeja Bus Park');
      expect(fixture.componentInstance['form'].controls.business.disabled).toBe(true);
    });

    it('patches the stop at its id on submit', async () => {
      const stop = makeStop();
      const { fixture, apiClient } = await setup('stop-1', [stop]);
      fixture.detectChanges();
      await fixture.whenStable();
      apiClient.PATCH.and.resolveTo({ data: stop });
      const router = TestBed.inject(Router);
      spyOn(router, 'navigate').and.resolveTo(true);

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.PATCH).toHaveBeenCalledWith(
        '/api/v1/stops/{id}/',
        jasmine.objectContaining({ params: { path: { id: 'stop-1' } } }),
      );
    });

    it('shows a not-found message when the stop is not in the store', async () => {
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
