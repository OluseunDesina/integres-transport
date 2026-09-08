import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { ScheduleForm } from './schedule-form';
import { BusinessOptionsService } from '../../shared/business-options.service';
import { ScheduleStore, type Schedule } from '../../shared/data/store/schedule.store';

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch-1',
    route: 'route-1',
    route_name: 'Ikeja Express',
    business: 'biz-1',
    days_of_week: [1, 3, 5],
    departure_time: '07:30:00',
    effective_from: '2026-01-01',
    effective_until: null,
    trip_class: 'standard',
    is_active: true,
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeScheduleStore {
  items = signal<Schedule[]>([]);
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

async function setup(paramId: string | null, existing: Schedule[] = []) {
  const apiClient = {
    GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
    POST: jasmine.createSpy('POST'),
    PATCH: jasmine.createSpy('PATCH'),
  };
  const store = new FakeScheduleStore();
  store.items.set(existing);
  const businessOptions = new FakeBusinessOptions();

  await TestBed.configureTestingModule({
    imports: [ScheduleForm],
    providers: [
      provideRouter([]),
      { provide: API_CLIENT, useValue: apiClient },
      { provide: ScheduleStore, useValue: store },
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

  const fixture = TestBed.createComponent(ScheduleForm);
  return { fixture, apiClient, store };
}

describe('ScheduleForm', () => {
  describe('create mode', () => {
    let fixture: ComponentFixture<ScheduleForm>;
    let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy; PATCH: jasmine.Spy };

    beforeEach(async () => {
      ({ fixture, apiClient } = await setup(null));
      fixture.detectChanges();
      await fixture.whenStable();
    });

    it('renders the "New schedule" heading', () => {
      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('New schedule');
    });

    it('loads route options scoped to the chosen Business', async () => {
      apiClient.GET.calls.reset();
      fixture.componentInstance['form'].controls.business.setValue('biz-1');
      await fixture.whenStable();

      expect(apiClient.GET).toHaveBeenCalledWith(
        '/api/v1/routes/',
        jasmine.objectContaining({
          params: { query: { limit: 100, offset: 0, business: 'biz-1' } },
        })
      );
    });

    it('shows a hint to create a Route first when the chosen Business has none yet', async () => {
      apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });
      fixture.componentInstance['form'].controls.business.setValue('biz-1');
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.componentInstance['noRoutesAvailable']()).toBe(true);
      expect(fixture.nativeElement.textContent).toContain('has no routes yet');
    });

    // docs/specs/15-trip-classes.md. The narrowing matters because the
    // backend refuses a class outside the route's allow-list with a
    // 400: offering it at all means an operator can only discover the
    // refusal by submitting.
    describe('service class', () => {
      async function chooseRouteWithClasses(available: string[]): Promise<void> {
        apiClient.GET.and.resolveTo({
          data: {
            count: 1,
            results: [
              {
                id: 'route-1',
                name: 'Ikeja Express',
                available_trip_classes: available,
              },
            ],
          },
        });
        fixture.componentInstance['form'].controls.business.setValue('biz-1');
        await fixture.whenStable();
        fixture.componentInstance['form'].controls.route.setValue('route-1');
        fixture.detectChanges();
      }

      it('offers every class when the route restricts none', async () => {
        await chooseRouteWithClasses([]);

        expect(fixture.componentInstance['tripClassOptions']().map((o) => o.value)).toEqual([
          'premium',
          'exclusive',
          'standard',
          'mini',
        ]);
      });

      it('narrows the options to the classes the route offers', async () => {
        await chooseRouteWithClasses(['premium', 'standard']);

        expect(fixture.componentInstance['tripClassOptions']().map((o) => o.value)).toEqual([
          'premium',
          'standard',
        ]);
      });

      /**
       * The regression guard for the recorded `computed()` trap: a
       * computed over `form.controls.route.value` depends on no signal
       * and caches its first result forever. Selecting a *second* route
       * is what exposes it — one selection alone passes either way.
       */
      it('re-narrows when a different route is chosen', async () => {
        // Both routes come from **one** fetch, so switching between
        // them changes only the form control — nothing else. That is
        // what makes this a real guard: a `computed()` reading
        // `form.controls.route.value` still depends on `classesByRoute`,
        // so a version of this test that also refetched would pass
        // against the bug it is meant to catch.
        apiClient.GET.and.resolveTo({
          data: {
            count: 2,
            results: [
              { id: 'route-1', name: 'Ikeja Express', available_trip_classes: ['premium'] },
              { id: 'route-2', name: 'Yaba Loop', available_trip_classes: ['mini', 'standard'] },
            ],
          },
        });
        fixture.componentInstance['form'].controls.business.setValue('biz-1');
        await fixture.whenStable();

        fixture.componentInstance['form'].controls.route.setValue('route-1');
        expect(fixture.componentInstance['tripClassOptions']().map((o) => o.value)).toEqual([
          'premium',
        ]);

        fixture.componentInstance['form'].controls.route.setValue('route-2');
        expect(fixture.componentInstance['tripClassOptions']().map((o) => o.value)).toEqual([
          'standard',
          'mini',
        ]);
      });

      /**
       * Narrowing the options is only half the job. A control still
       * holding `standard` while the route offers Premium alone renders
       * a `<select>` with no matching `<option>`: it looks empty, keeps
       * its old value, and 400s on submit with "this route does not
       * offer standard services" — the exact failure the narrowing
       * exists to prevent, reached from the other side. Found by
       * `e2e/client-admin-app/trip-classes.spec.ts` after the unit
       * tests here were already green.
       */
      it('moves the selection into range when the route excludes it', async () => {
        expect(fixture.componentInstance['form'].controls.trip_class.value).toBe('standard');

        await chooseRouteWithClasses(['premium']);

        expect(fixture.componentInstance['form'].controls.trip_class.value).toBe('premium');
      });

      it('leaves an already-allowed selection alone', async () => {
        await chooseRouteWithClasses(['premium', 'standard']);

        expect(fixture.componentInstance['form'].controls.trip_class.value).toBe('standard');
      });

      it('sends the chosen class when creating', async () => {
        await chooseRouteWithClasses([]);
        apiClient.POST.and.resolveTo({ data: makeSchedule() });
        spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        fixture.componentInstance['toggleDay'](1);
        fixture.componentInstance['form'].patchValue({
          departure_time: '07:30',
          effective_from: '2026-01-01',
          trip_class: 'premium',
        });

        await fixture.componentInstance['onSubmit']();

        expect(apiClient.POST).toHaveBeenCalledWith(
          '/api/v1/schedules/',
          jasmine.objectContaining({
            body: jasmine.objectContaining({ trip_class: 'premium' }),
          })
        );
      });
    });

    it('toggling a day updates the selected days', () => {
      expect(fixture.componentInstance['isDaySelected'](1)).toBe(false);
      fixture.componentInstance['toggleDay'](1);
      expect(fixture.componentInstance['isDaySelected'](1)).toBe(true);
      fixture.componentInstance['toggleDay'](1);
      expect(fixture.componentInstance['isDaySelected'](1)).toBe(false);
    });

    it('rejects submission with no days of week selected', async () => {
      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        route: 'route-1',
        departure_time: '07:30',
        effective_from: '2026-01-01',
        effective_until: '',
        trip_class: 'standard',
      });

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.POST).not.toHaveBeenCalled();
      expect(fixture.componentInstance['errorMessage']()).toContain('day of the week');
    });

    it('creates a schedule and navigates to /schedules on success', async () => {
      apiClient.POST.and.resolveTo({ data: makeSchedule() });
      const router = TestBed.inject(Router);
      const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        route: 'route-1',
        departure_time: '07:30',
        effective_from: '2026-01-01',
        effective_until: '',
        trip_class: 'standard',
      });
      fixture.componentInstance['toggleDay'](1);

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/schedules/',
        jasmine.objectContaining({
          body: jasmine.objectContaining({
            route: 'route-1',
            days_of_week: [1],
          }),
        })
      );
      expect(navigateSpy).toHaveBeenCalledWith(['/schedules']);
    });

    it('shows the server error message on failure', async () => {
      apiClient.POST.and.resolveTo({
        error: { route: ['Unknown route.'] },
      });
      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        route: 'bad-route',
        departure_time: '07:30',
        effective_from: '2026-01-01',
        effective_until: '',
        trip_class: 'standard',
      });
      fixture.componentInstance['toggleDay'](1);

      await fixture.componentInstance['onSubmit']();
      fixture.detectChanges();

      // Rendered under the Route select rather than stored in a
      // page-level alert.
      const errors = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('ui-select [role="alert"]'),
      ).map((el) => el.textContent?.trim());
      expect(errors).toContain('Unknown route.');
      expect(fixture.componentInstance['errorMessage']()).toBeNull();
    });
  });

  describe('edit mode', () => {
    it('prefills the form and disables business and route', async () => {
      const schedule = makeSchedule();
      const { fixture } = await setup('sch-1', [schedule]);

      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Edit schedule');
      expect(fixture.componentInstance['form'].value.departure_time).toBe('07:30:00');
      expect(fixture.componentInstance['selectedDays']()).toEqual([1, 3, 5]);
      expect(fixture.componentInstance['form'].controls.business.disabled).toBe(true);
      expect(fixture.componentInstance['form'].controls.route.disabled).toBe(true);
    });

    it('patches the schedule at its id on submit', async () => {
      const schedule = makeSchedule();
      const { fixture, apiClient } = await setup('sch-1', [schedule]);
      fixture.detectChanges();
      await fixture.whenStable();
      apiClient.PATCH.and.resolveTo({ data: schedule });
      const router = TestBed.inject(Router);
      spyOn(router, 'navigate').and.resolveTo(true);

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.PATCH).toHaveBeenCalledWith(
        '/api/v1/schedules/{id}/',
        jasmine.objectContaining({ params: { path: { id: 'sch-1' } } })
      );
    });

    it('shows a not-found message when the schedule is not in the store', async () => {
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
