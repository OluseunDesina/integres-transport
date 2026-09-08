import { Dialog } from '@angular/cdk/dialog';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { expectColumnVisibilityParity } from '@shared-ui';
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
    // docs/specs/16-operational-analytics.md slice 1 — null
    // on every Trip that has not departed, which is most of them.
    actual_departure_at: null,
    actual_arrival_at: null,
    vehicle: null,
    driver: null,
    booking_mode: 'reservation',
    fare_collection_mode: 'prepaid',
    trip_class: 'standard',
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
  query = signal<{
    route?: string;
    schedule?: string;
    service_date?: string;
    status?: string;
  }>({});
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
    dialogSpy.open.and.returnValue({
      closed: closedSubject.asObservable(),
    } as ReturnType<Dialog['open']>);

    await TestBed.configureTestingModule({
      imports: [TripList],
      providers: [
        provideRouter([]),
        { provide: TripStore, useValue: store },
        { provide: API_CLIENT, useValue: apiClient },
        { provide: Dialog, useValue: dialogSpy },
        {
          provide: SelectedBusinessStore,
          useValue: new FakeSelectedBusinessStore(),
        },
      ],
    }).compileComponents();

    const authStore = TestBed.inject(AuthStore);
    authStore.setSession(
      'a',
      'r',
      makeUser({
        permissions: ['client-admin:access', 'scheduling.view', 'scheduling.manage'],
      })
    );

    fixture = TestBed.createComponent(TripList);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('scopes the query to the active Business on init', () => {
    // Not getAll(): an unscoped fetch here would race the scoped one the
    // effect fires, and the table would briefly show every Business's
    // Trips. GET /trips/ takes a ?business= param now, so this screen
    // scopes its rows the way every sibling list already did.
    expect(store.updateQuery).toHaveBeenCalledWith({ business: 'biz-1' });
    expect(store.getAll).not.toHaveBeenCalled();
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No trips yet');
  });

  // Filters now flow through ListFilters and the shared filter bar, so
  // every one of them carries the whole query — including the business
  // scope, which must never be dropped when a filter changes.

  it('keeps the Business scope when a filter changes', () => {
    fixture.componentInstance['onExtraFilterChange']('route', 'route-1');

    expect(store.updateQuery).toHaveBeenCalledWith(
      jasmine.objectContaining({ business: 'biz-1', route: 'route-1' })
    );
  });

  it('sends undefined for a filter that is cleared', () => {
    fixture.componentInstance['onExtraFilterChange']('route', 'route-1');
    fixture.componentInstance['onExtraFilterChange']('route', '');

    expect(store.updateQuery).toHaveBeenCalledWith(jasmine.objectContaining({ route: undefined }));
  });

  it('carries the schedule/service_date/status filters through the same path', () => {
    fixture.componentInstance['onExtraFilterChange']('schedule', 'sch-1');
    expect(store.updateQuery).toHaveBeenCalledWith(jasmine.objectContaining({ schedule: 'sch-1' }));

    fixture.componentInstance['onExtraFilterChange']('service_date', '2026-09-01');
    expect(store.updateQuery).toHaveBeenCalledWith(
      jasmine.objectContaining({ service_date: '2026-09-01' })
    );

    fixture.componentInstance['onExtraFilterChange']('status', 'cancelled');
    expect(store.updateQuery).toHaveBeenCalledWith(
      jasmine.objectContaining({ status: 'cancelled' })
    );
  });

  it('renders a chip per active filter, naming the route rather than its id', () => {
    // A UUID on a chip tells an operator nothing.
    fixture.componentInstance['onExtraFilterChange']('status', 'cancelled');
    fixture.detectChanges();

    const chips = fixture.debugElement
      .queryAll(By.css('button'))
      .filter((el) =>
        (el.nativeElement as HTMLElement).getAttribute('aria-label')?.startsWith('Remove filter')
      );
    expect(chips.length).toBe(1);
    expect((chips[0].nativeElement as HTMLElement).textContent).toContain('Status: Cancelled');
  });

  // Assignment moved out of the row and into a drawer — it used to be
  // two inline selects that reassigned a vehicle or driver the moment
  // they changed, with no confirmation.

  it('renders vehicle and driver read-only in the row, with no select', () => {
    store.items.set([makeTrip({ driver: { id: 'd-1', name: 'Tunde Bello' } })]);
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('tbody select'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Tunde Bello');
  });

  it('sends both vehicle and driver together when the drawer saves, then refetches', async () => {
    store.items.set([makeTrip({ driver: { id: 'd-1', name: 'Tunde Bello' } })]);
    fixture.detectChanges();
    await fixture.whenStable();
    apiClient.PATCH.and.resolveTo({ data: makeTrip() });
    store.getAll.calls.reset();

    fixture.componentInstance['assigning'].set(store.items()[0]);
    fixture.componentInstance['setPendingVehicle']('v-1');
    fixture.componentInstance['setPendingDriver']('d-1');
    await fixture.componentInstance['saveAssignment']();

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

    fixture.componentInstance['assigning'].set(store.items()[0]);
    fixture.componentInstance['setPendingVehicle']('v-1');
    await fixture.componentInstance['saveAssignment']();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Forbidden.');
    expect(store.getAll).not.toHaveBeenCalled();
  });

  it('writes nothing when the drawer is opened but never saved', () => {
    // The point of moving assignment off the row: opening it is not a
    // write.
    store.items.set([makeTrip()]);
    fixture.detectChanges();
    apiClient.PATCH.calls.reset();

    fixture.componentInstance['onMenuSelected'](store.items()[0], 'assign');

    expect(apiClient.PATCH).not.toHaveBeenCalled();
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
  // --- docs/specs/15-trip-classes.md ---

  describe('service class', () => {
    it('renders the class as a label, not only a colour', () => {
      store.items.set([makeTrip({ trip_class: 'premium' })]);
      fixture.detectChanges();

      // The pill is neutral-toned for every class deliberately, so the
      // word is the entire signal — which is why asserting on the text
      // is asserting on the whole mechanism.
      expect(fixture.nativeElement.textContent).toContain('Premium');
    });

    it('sends the class filter to the store', () => {
      store.updateQuery.calls.reset();

      fixture.componentInstance['onExtraFilterChange']('trip_class', 'premium');
      fixture.componentInstance['applyFilters']();

      expect(store.updateQuery).toHaveBeenCalledWith(
        jasmine.objectContaining({ trip_class: 'premium' })
      );
    });

    it('offers the action on a completed trip too', () => {
      // Unlike "Change status", which is hidden for terminal trips.
      // Whether a class *can* move depends on bookings, which this
      // screen cannot see — so the backend refuses, rather than the
      // menu guessing.
      const items = fixture.componentInstance['menuItems'](makeTrip({ status: 'completed' }));

      expect(items.map((item) => item.id)).toContain('class');
    });

    it('POSTs the chosen class via onConfirm', async () => {
      apiClient.POST.and.resolveTo({ data: makeTrip({ trip_class: 'premium' }) });
      const trip = makeTrip({ trip_class: 'standard' });
      store.items.set([trip]);
      fixture.detectChanges();

      fixture.componentInstance['changeClass'](trip);
      fixture.componentInstance['setPendingClass']('premium');
      const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
      const result = await data.onConfirm();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/trips/{id}/class/',
        jasmine.objectContaining({
          params: { path: { id: 'trip-1' } },
          body: { trip_class: 'premium' },
        })
      );
      expect(result).toEqual({ ok: true });
    });

    it('seeds the dialog with the class the trip already has', () => {
      const trip = makeTrip({ trip_class: 'mini' });
      store.items.set([trip]);
      fixture.detectChanges();

      fixture.componentInstance['changeClass'](trip);

      expect(fixture.componentInstance['pendingClass']()).toBe('mini');
    });

    /**
     * The refusal path, and the reason the action is offered on every
     * row. The backend's sentence is more specific than anything this
     * screen could say, so it is surfaced rather than replaced.
     */
    it('surfaces the backend’s own sentence when a sold trip is refused', async () => {
      apiClient.POST.and.resolveTo({
        error: {
          detail: 'This trip already has bookings, so its class can no longer be changed.',
        },
      });
      const trip = makeTrip({ trip_class: 'standard' });
      store.items.set([trip]);
      fixture.detectChanges();

      fixture.componentInstance['changeClass'](trip);
      const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
      const result = await data.onConfirm();

      expect(result).toEqual({
        ok: false,
        error: 'This trip already has bookings, so its class can no longer be changed.',
      });
    });
  });

  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makeTrip()]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'trip-list rows');
  });

  it('keeps the skeleton row aligned with the header too', () => {
    store.loading.set(true);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'trip-list skeleton');
  });
});
