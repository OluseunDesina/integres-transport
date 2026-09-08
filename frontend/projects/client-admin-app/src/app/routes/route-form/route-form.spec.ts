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
    available_trip_classes: [],
    status: 'active',
    distance_km: null,
    estimated_duration_minutes: null,
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

    // docs/specs/15-trip-classes.md. `available_trip_classes` is a
    // checkbox group over a local signal, mirroring the days-of-week
    // picker — not a form control, so these read the signal.
    describe('service classes', () => {
      it('renders one checkbox per class', () => {
        const labels = Array.from(
          fixture.nativeElement.querySelectorAll('ui-checkbox label')
        ).map((label) => (label as HTMLElement).textContent?.trim());

        expect(labels).toEqual(['Premium', 'Exclusive', 'Standard', 'Mini']);
      });

      /**
       * The reading that matters most on this screen. Empty means
       * *every* class is allowed, and an all-unchecked group otherwise
       * reads as "none" — the opposite. Every route that predates spec
       * 15 has an empty list, so getting this backwards would make all
       * of them look broken.
       */
      it('says that selecting nothing accepts every class', () => {
        expect(fixture.componentInstance['allClassesAllowed']()).toBe(true);
        expect(fixture.nativeElement.textContent).toContain('accepts every class');
      });

      it('stops saying so once a class is chosen', () => {
        fixture.componentInstance['toggleClass']('premium', true);
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).not.toContain('accepts every class');
      });

      it('toggles a class on and off again', () => {
        expect(fixture.componentInstance['isClassSelected']('premium')).toBe(false);
        fixture.componentInstance['toggleClass']('premium', true);
        expect(fixture.componentInstance['isClassSelected']('premium')).toBe(true);
        fixture.componentInstance['toggleClass']('premium', false);
        expect(fixture.componentInstance['isClassSelected']('premium')).toBe(false);
      });

      it('submits the chosen classes as an array', async () => {
        apiClient.POST.and.resolveTo({ data: makeRoute() });
        spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        fixture.componentInstance['form'].setValue({
          business: 'biz-1',
          name: 'Ikeja Express',
          code: '',
          description: '',
          distance_km: '',
          estimated_duration_minutes: '',
        });
        fixture.componentInstance['toggleClass']('premium', true);
        fixture.componentInstance['toggleClass']('standard', true);

        await fixture.componentInstance['onSubmit']();

        expect(apiClient.POST).toHaveBeenCalledWith(
          '/api/v1/routes/',
          jasmine.objectContaining({
            body: jasmine.objectContaining({
              available_trip_classes: ['premium', 'standard'],
            }),
          }),
        );
      });
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
        distance_km: '',
        estimated_duration_minutes: '',
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
        distance_km: '',
        estimated_duration_minutes: '',
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

    // docs/specs/19-route-lifecycle.md slice 2.
    describe('depth fields', () => {
      it('prefills distance and duration when set', async () => {
        const route = makeRoute({ distance_km: '12.50', estimated_duration_minutes: 45 });
        const { fixture } = await setup('route-1', [route]);
        fixture.detectChanges();
        await fixture.whenStable();

        expect(fixture.componentInstance['form'].value.distance_km).toBe('12.50');
        expect(fixture.componentInstance['form'].value.estimated_duration_minutes).toBe('45');
      });

      it('leaves both blank rather than "0" or "null" when unset', async () => {
        const route = makeRoute();
        const { fixture } = await setup('route-1', [route]);
        fixture.detectChanges();
        await fixture.whenStable();

        expect(fixture.componentInstance['form'].value.distance_km).toBe('');
        expect(fixture.componentInstance['form'].value.estimated_duration_minutes).toBe('');
      });

      it('sends null, not an empty string, when a blank field is submitted', async () => {
        const route = makeRoute();
        const { fixture, apiClient } = await setup('route-1', [route]);
        fixture.detectChanges();
        await fixture.whenStable();
        apiClient.PATCH.and.resolveTo({ data: route });

        await fixture.componentInstance['onSubmit']();

        expect(apiClient.PATCH).toHaveBeenCalledWith(
          '/api/v1/routes/{id}/',
          jasmine.objectContaining({
            body: jasmine.objectContaining({
              distance_km: null,
              estimated_duration_minutes: null,
            }),
          }),
        );
      });

      it('sends a parsed number and the raw decimal string when both are set', async () => {
        const route = makeRoute();
        const { fixture, apiClient } = await setup('route-1', [route]);
        fixture.detectChanges();
        await fixture.whenStable();
        apiClient.PATCH.and.resolveTo({ data: route });
        fixture.componentInstance['form'].patchValue({
          distance_km: '12.5',
          estimated_duration_minutes: '45',
        });

        await fixture.componentInstance['onSubmit']();

        expect(apiClient.PATCH).toHaveBeenCalledWith(
          '/api/v1/routes/{id}/',
          jasmine.objectContaining({
            body: jasmine.objectContaining({
              distance_km: '12.5',
              estimated_duration_minutes: 45,
            }),
          }),
        );
      });
    });

    describe('archived route', () => {
      it('disables the form and shows a restore-first message', async () => {
        const route = makeRoute({ status: 'archived' });
        const { fixture } = await setup('route-1', [route]);
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(fixture.componentInstance['form'].disabled).toBe(true);
        expect((fixture.nativeElement as HTMLElement).textContent).toContain(
          'cannot be edited',
        );
      });

      it('refuses to submit even if called directly', async () => {
        const route = makeRoute({ status: 'archived' });
        const { fixture, apiClient } = await setup('route-1', [route]);
        fixture.detectChanges();
        await fixture.whenStable();

        await fixture.componentInstance['onSubmit']();

        expect(apiClient.PATCH).not.toHaveBeenCalled();
      });
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
  
  // --- docs/specs/14 slice 4 ---

  describe('sections', () => {
    it('offers no tab list while creating, since there are no stops yet', async () => {
      const { fixture } = await setup(null);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect((fixture.nativeElement as HTMLElement).querySelector('ui-tabs')).toBeNull();
    });

    it('splits details from stops once the route exists', async () => {
      const { fixture } = await setup('route-1', [makeRoute()]);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const tabs = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('[role="tab"]'),
      ).map((el) => el.textContent?.trim());
      expect(tabs).toEqual(['Details', 'Stops']);

      // Details is the landing panel; the stop picker is not rendered
      // until its tab is chosen.
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('Route name');
      expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Add a stop');

      fixture.componentInstance['setActiveTab']('stops');
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('Add a stop');
    });
  });

  describe('validation', () => {
    it('renders a message when a required field is submitted empty', async () => {
      // The rendered output, not just the request that did not happen:
      // `ui-text-field` shows nothing unless the parent binds both
      // `invalid` and `errorMessage`, and a form binding neither fails
      // this way silently.
      const { fixture, apiClient } = await setup(null);
      fixture.detectChanges();
      await fixture.whenStable();

      await fixture.componentInstance['onSubmit']();
      fixture.detectChanges();

      expect(apiClient.POST).not.toHaveBeenCalled();
      const error = (fixture.nativeElement as HTMLElement).querySelector(
        'ui-text-field [role="alert"]',
      );
      expect(error?.textContent?.trim()).toBe('This field is required.');
    });
  });
});
});
