import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { RouteForm } from './route-form';
import { BusinessOptionsService } from '../../shared/business-options.service';
import { RouteStore, type Route } from '../../shared/data/store/route.store';

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    id: 'route-1',
    business: 'biz-1',
    name: 'Ikeja Express',
    code: '',
    description: '',
    is_active: true,
    stops: [],
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeRouteStore {
  items = signal<Route[]>([]);
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

async function setup(paramId: string | null, existing: Route[] = []) {
  const apiClient = {
    GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
    POST: jasmine.createSpy('POST'),
    PATCH: jasmine.createSpy('PATCH'),
    PUT: jasmine.createSpy('PUT'),
  };
  const store = new FakeRouteStore();
  store.items.set(existing);
  const businessOptions = new FakeBusinessOptions();

  await TestBed.configureTestingModule({
    imports: [RouteForm],
    providers: [
      provideRouter([]),
      { provide: API_CLIENT, useValue: apiClient },
      { provide: RouteStore, useValue: store },
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

  const fixture = TestBed.createComponent(RouteForm);
  return { fixture, apiClient, store, businessOptions };
}

describe('RouteForm', () => {
  describe('create mode', () => {
    let fixture: ComponentFixture<RouteForm>;
    let apiClient: {
      GET: jasmine.Spy;
      POST: jasmine.Spy;
      PATCH: jasmine.Spy;
      PUT: jasmine.Spy;
    };

    beforeEach(async () => {
      ({ fixture, apiClient } = await setup(null));
      fixture.detectChanges();
      await fixture.whenStable();
    });

    it('renders the "New route" heading', () => {
      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('New route');
    });

    it('does not submit an invalid (missing business/name) form', async () => {
      await fixture.componentInstance['onSubmit']();
      expect(apiClient.POST).not.toHaveBeenCalled();
    });

    it('creates a route and navigates to its edit page on success', async () => {
      apiClient.POST.and.resolveTo({ data: makeRoute() });
      const router = TestBed.inject(Router);
      const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        name: 'Ikeja Express',
        code: '',
        description: '',
      });

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/routes/',
        jasmine.objectContaining({
          body: jasmine.objectContaining({
            business: 'biz-1',
            name: 'Ikeja Express',
          }),
        }),
      );
      expect(navigateSpy).toHaveBeenCalledWith(['/routes', 'route-1', 'edit']);
    });

    it('shows the server error message on failure', async () => {
      apiClient.POST.and.resolveTo({
        error: {
          business: ['This Business must be KYB-approved before creating Routes.'],
        },
      });
      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        name: 'Ikeja Express',
        code: '',
        description: '',
      });

      await fixture.componentInstance['onSubmit']();
      fixture.detectChanges();

      expect(fixture.componentInstance['errorMessage']()).toBe(
        'This Business must be KYB-approved before creating Routes.',
      );
    });
  });

  describe('edit mode', () => {
    it('prefills the form and disables the business field', async () => {
      const route = makeRoute();
      const { fixture } = await setup('route-1', [route]);

      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Edit route');
      expect(fixture.componentInstance['form'].value.name).toBe('Ikeja Express');
      expect(fixture.componentInstance['form'].controls.business.disabled).toBe(true);
    });

    it('patches the route at its id on submit', async () => {
      const route = makeRoute();
      const { fixture, apiClient } = await setup('route-1', [route]);
      fixture.detectChanges();
      await fixture.whenStable();
      apiClient.PATCH.and.resolveTo({ data: route });

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.PATCH).toHaveBeenCalledWith(
        '/api/v1/routes/{id}/',
        jasmine.objectContaining({ params: { path: { id: 'route-1' } } }),
      );
    });

    describe('stop ordering', () => {
      async function setupWithStops() {
        const route = makeRoute();
        const result = await setup('route-1', [route]);
        result.apiClient.GET.and.resolveTo({
          data: {
            count: 2,
            results: [
              { id: 'stop-a', business: 'biz-1', name: 'Stop A' },
              { id: 'stop-b', business: 'biz-1', name: 'Stop B' },
            ],
          },
        });
        result.fixture.detectChanges();
        await result.fixture.whenStable();
        result.fixture.detectChanges();
        return result;
      }

      it('adds a selected stop to the ordered list', async () => {
        const { fixture } = await setupWithStops();

        fixture.componentInstance['setStopToAdd']('stop-a');
        fixture.componentInstance['addStop']();

        expect(fixture.componentInstance['routeStops']().map((s) => s.id)).toEqual(['stop-a']);
      });

      it('removes a stop from the ordered list', async () => {
        const { fixture } = await setupWithStops();
        fixture.componentInstance['setStopToAdd']('stop-a');
        fixture.componentInstance['addStop']();

        fixture.componentInstance['removeStop']('stop-a');

        expect(fixture.componentInstance['routeStops']()).toEqual([]);
      });

      it('reorders stops via moveStop', async () => {
        const { fixture } = await setupWithStops();
        fixture.componentInstance['setStopToAdd']('stop-a');
        fixture.componentInstance['addStop']();
        fixture.componentInstance['setStopToAdd']('stop-b');
        fixture.componentInstance['addStop']();

        fixture.componentInstance['moveStop'](1, -1);

        expect(fixture.componentInstance['routeStops']().map((s) => s.id)).toEqual([
          'stop-b',
          'stop-a',
        ]);
      });

      it('saves the ordered stop id array via PUT', async () => {
        const { fixture, apiClient } = await setupWithStops();
        fixture.componentInstance['setStopToAdd']('stop-b');
        fixture.componentInstance['addStop']();
        fixture.componentInstance['setStopToAdd']('stop-a');
        fixture.componentInstance['addStop']();
        apiClient.PUT.and.resolveTo({ data: makeRoute() });

        await fixture.componentInstance['saveStopOrder']();

        expect(apiClient.PUT).toHaveBeenCalledWith(
          '/api/v1/routes/{id}/stops/',
          jasmine.objectContaining({
            params: { path: { id: 'route-1' } },
            body: { stops: ['stop-b', 'stop-a'] },
          }),
        );
        expect(fixture.componentInstance['stopsSaved']()).toBe(true);
      });
    });
  });
});
