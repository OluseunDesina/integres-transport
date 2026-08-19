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
    business: 'biz-1',
    days_of_week: [1, 3, 5],
    departure_time: '07:30:00',
    effective_from: '2026-01-01',
    effective_until: null,
    is_active: true,
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeScheduleStore {
  items = signal<Schedule[]>([]);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
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
        useValue: { snapshot: { paramMap: convertToParamMap(paramId ? { id: paramId } : {}) } },
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
        is_active: true,
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
        is_active: true,
      });
      fixture.componentInstance['toggleDay'](1);

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/schedules/',
        jasmine.objectContaining({
          body: jasmine.objectContaining({ route: 'route-1', days_of_week: [1] }),
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
        is_active: true,
      });
      fixture.componentInstance['toggleDay'](1);

      await fixture.componentInstance['onSubmit']();
      fixture.detectChanges();

      expect(fixture.componentInstance['errorMessage']()).toBe('Unknown route.');
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
