import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { ScheduleList } from './schedule-list';
import { RouteStore, type Route } from '../../shared/data/store/route.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { ScheduleStore, type Schedule } from '../../shared/data/store/schedule.store';

function makeUser(overrides: Partial<AuthUser>): AuthUser {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    firstName: '',
    lastName: '',
    client: 'client-1',
    isPlatformStaff: false,
    isClientStaff: true,
    permissions: [],
    roleName: null,
    clientName: null,
    ...overrides,
  };
}

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

class FakeScheduleStore {
  items = signal<Schedule[]>([]);
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  updateQuery = jasmine.createSpy('updateQuery').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

class FakeRouteStore {
  items = signal<Route[]>([]);
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

class FakeSelectedBusinessStore {
  selectedBusinessId = signal<string | null>('biz-1');
}

describe('ScheduleList', () => {
  let fixture: ComponentFixture<ScheduleList>;
  let store: FakeScheduleStore;
  let routeStore: FakeRouteStore;

  beforeEach(async () => {
    localStorage.clear();
    store = new FakeScheduleStore();
    routeStore = new FakeRouteStore();

    await TestBed.configureTestingModule({
      imports: [ScheduleList],
      providers: [
        provideRouter([]),
        { provide: ScheduleStore, useValue: store },
        { provide: RouteStore, useValue: routeStore },
        { provide: SelectedBusinessStore, useValue: new FakeSelectedBusinessStore() },
      ],
    }).compileComponents();

    const authStore = TestBed.inject(AuthStore);
    authStore.setSession(
      'a',
      'r',
      makeUser({ permissions: ['client-admin:access', 'scheduling.view'] })
    );

    fixture = TestBed.createComponent(ScheduleList);
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('scopes the query to the active Business on init', () => {
    expect(store.updateQuery).toHaveBeenCalledWith({ business: 'biz-1' });
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No schedules yet');
  });

  it('renders the route name and formatted days of week for a row', () => {
    routeStore.items.set([makeRoute()]);
    store.items.set([makeSchedule()]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Ikeja Express');
    expect(fixture.nativeElement.textContent).toContain('Mon/Wed/Fri');
  });
});
