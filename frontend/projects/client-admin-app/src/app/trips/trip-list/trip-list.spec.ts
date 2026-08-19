import { Dialog } from '@angular/cdk/dialog';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';
import type { ConfirmDialogData } from '@shared-ui';
import { Subject } from 'rxjs';

import { TripList } from './trip-list';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { TripStore, type Trip } from '../../shared/data/store/trip.store';

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

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
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
    ...overrides,
  };
}

class FakeTripStore {
  items = signal<Trip[]>([]);
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  query = signal<{ route?: string; schedule?: string; service_date?: string; status?: string }>({});
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  updateQuery = jasmine.createSpy('updateQuery').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

class FakeSelectedBusinessStore {
  selectedBusinessId = signal<string | null>('biz-1');
}

describe('TripList', () => {
  let fixture: ComponentFixture<TripList>;
  let store: FakeTripStore;
  let apiClient: { GET: jasmine.Spy; PATCH: jasmine.Spy; POST: jasmine.Spy };
  let dialogSpy: jasmine.SpyObj<Dialog>;
  let closedSubject: Subject<boolean | undefined>;

  beforeEach(async () => {
    localStorage.clear();
    store = new FakeTripStore();
    apiClient = {
      GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
      PATCH: jasmine.createSpy('PATCH'),
      POST: jasmine.createSpy('POST'),
    };
    closedSubject = new Subject<boolean | undefined>();
    dialogSpy = jasmine.createSpyObj<Dialog>('Dialog', ['open']);
    dialogSpy.open.and.returnValue({ closed: closedSubject.asObservable() } as ReturnType<
      Dialog['open']
    >);

    await TestBed.configureTestingModule({
      imports: [TripList],
      providers: [
        provideRouter([]),
        { provide: TripStore, useValue: store },
        { provide: API_CLIENT, useValue: apiClient },
        { provide: Dialog, useValue: dialogSpy },
        { provide: SelectedBusinessStore, useValue: new FakeSelectedBusinessStore() },
      ],
    }).compileComponents();

    const authStore = TestBed.inject(AuthStore);
    authStore.setSession(
      'a',
      'r',
      makeUser({ permissions: ['client-admin:access', 'scheduling.view', 'scheduling.manage'] })
    );

    fixture = TestBed.createComponent(TripList);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('calls getAll() on init', () => {
    expect(store.getAll).toHaveBeenCalled();
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No trips found');
  });

  it('calls updateQuery with undefined when a filter is cleared', () => {
    fixture.componentInstance['onRouteFilterChange']('route-1');
    expect(store.updateQuery).toHaveBeenCalledWith({ route: 'route-1' });

    fixture.componentInstance['onRouteFilterChange']('');
    expect(store.updateQuery).toHaveBeenCalledWith({ route: undefined });
  });

  it('calls updateQuery for the schedule/service_date/status filters', () => {
    fixture.componentInstance['onScheduleFilterChange']('sch-1');
    expect(store.updateQuery).toHaveBeenCalledWith({ schedule: 'sch-1' });

    fixture.componentInstance['onServiceDateFilterChange']('2026-09-01');
    expect(store.updateQuery).toHaveBeenCalledWith({ service_date: '2026-09-01' });

    fixture.componentInstance['onStatusFilterChange']('cancelled');
    expect(store.updateQuery).toHaveBeenCalledWith({ status: 'cancelled' });
  });

  it('sends both vehicle and driver together on assignment PATCH, then refetches', async () => {
    store.items.set([makeTrip({ driver: { id: 'd-1', name: 'Tunde Bello' } })]);
    fixture.detectChanges();
    await fixture.whenStable();
    apiClient.PATCH.and.resolveTo({ data: makeTrip() });
    store.getAll.calls.reset();

    await fixture.componentInstance['onVehicleChange'](store.items()[0], 'v-1');

    expect(apiClient.PATCH).toHaveBeenCalledWith(
      '/api/v1/trips/{id}/',
      jasmine.objectContaining({
        params: { path: { id: 'trip-1' } },
        body: { vehicle: 'v-1', driver: 'd-1' },
      })
    );
    expect(store.getAll).toHaveBeenCalled();
  });

  it('shows an error and does not refetch when the assignment PATCH fails', async () => {
    store.items.set([makeTrip()]);
    fixture.detectChanges();
    await fixture.whenStable();
    apiClient.PATCH.and.resolveTo({ error: { detail: 'Forbidden.' } });
    store.getAll.calls.reset();

    await fixture.componentInstance['onVehicleChange'](store.items()[0], 'v-1');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Forbidden.');
    expect(store.getAll).not.toHaveBeenCalled();
  });

  it('offers Start/Cancel for a scheduled trip and requires a reason to cancel', () => {
    const trip = makeTrip({ status: 'scheduled' });
    store.items.set([trip]);
    fixture.detectChanges();

    fixture.componentInstance['changeStatus'](trip);

    expect(dialogSpy.open).toHaveBeenCalled();
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(fixture.componentInstance['statusOptions']().map((o) => o.target)).toEqual([
      'in_progress',
      'cancelled',
    ]);
    expect(data.confirmDisabled()).toBeFalse();

    fixture.componentInstance['setStatusTarget']('cancelled');
    expect(data.confirmDisabled()).toBeTrue();

    fixture.componentInstance['setStatusReason']('Operational issue');
    expect(data.confirmDisabled()).toBeFalse();
  });

  it('offers Complete/Cancel for an in_progress trip', () => {
    const trip = makeTrip({ status: 'in_progress' });
    store.items.set([trip]);
    fixture.detectChanges();

    fixture.componentInstance['changeStatus'](trip);

    expect(fixture.componentInstance['statusOptions']().map((o) => o.target)).toEqual([
      'completed',
      'cancelled',
    ]);
  });

  it('hides the "Change status" action for terminal trips', () => {
    store.items.set([makeTrip({ status: 'completed' })]);
    fixture.detectChanges();

    const buttons = fixture.debugElement
      .queryAll(By.css('tbody button'))
      .map((el) => (el.nativeElement.textContent as string).trim());
    expect(buttons).not.toContain('Change status');
  });

  it('POSTs the chosen status via onConfirm and reports success', async () => {
    apiClient.POST.and.resolveTo({ data: makeTrip({ status: 'in_progress' }) });
    const trip = makeTrip({ status: 'scheduled' });
    store.items.set([trip]);
    fixture.detectChanges();
    fixture.componentInstance['changeStatus'](trip);
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;

    const result = await data.onConfirm();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/trips/{id}/status/',
      jasmine.objectContaining({
        params: { path: { id: 'trip-1' } },
        body: { status: 'in_progress', reason: '' },
      })
    );
    expect(result).toEqual({ ok: true });
  });

  it('refetches once the status dialog closes', async () => {
    const trip = makeTrip({ status: 'scheduled' });
    store.items.set([trip]);
    fixture.detectChanges();
    fixture.componentInstance['changeStatus'](trip);
    store.getAll.calls.reset();

    closedSubject.next(true);
    await new Promise((resolve) => setTimeout(resolve));

    expect(store.getAll).toHaveBeenCalled();
  });
});
