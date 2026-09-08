import { Dialog } from '@angular/cdk/dialog';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';
import { DrawerService, expectColumnVisibilityParity } from '@shared-ui';
import type { ConfirmDialogData } from '@shared-ui';
import { Subject } from 'rxjs';

import { ScheduleList } from './schedule-list';
import { ScheduleStore, type Schedule } from '../../shared/data/store/schedule.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

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
    route_name: 'Ikeja Express',
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
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
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

const apiClientStub = {
  GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
  POST: jasmine.createSpy('POST').and.resolveTo({ data: {} }),
  PATCH: jasmine.createSpy('PATCH').and.resolveTo({ data: {} }),
};

describe('ScheduleList', () => {
  let fixture: ComponentFixture<ScheduleList>;
  let store: FakeScheduleStore;
  let dialogSpy: jasmine.SpyObj<Dialog>;
  let drawerSpy: jasmine.SpyObj<DrawerService>;
  let closedSubject: Subject<boolean | undefined>;

  async function render(permissions: string[]): Promise<void> {
    fixture?.destroy();
    TestBed.resetTestingModule();
    store = new FakeScheduleStore();
    closedSubject = new Subject<boolean | undefined>();
    dialogSpy = jasmine.createSpyObj<Dialog>('Dialog', ['open']);
    dialogSpy.open.and.returnValue({
      closed: closedSubject.asObservable(),
    } as ReturnType<Dialog['open']>);
    drawerSpy = jasmine.createSpyObj<DrawerService>('DrawerService', ['open']);

    await TestBed.configureTestingModule({
      imports: [ScheduleList],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: apiClientStub },
        { provide: ScheduleStore, useValue: store },
        { provide: Dialog, useValue: dialogSpy },
        { provide: DrawerService, useValue: drawerSpy },
        {
          provide: SelectedBusinessStore,
          useValue: new FakeSelectedBusinessStore(),
        },
      ],
    }).compileComponents();

    const authStore = TestBed.inject(AuthStore);
    authStore.setSession('a', 'r', makeUser({ permissions }));

    fixture = TestBed.createComponent(ScheduleList);
    fixture.detectChanges();
  }

  function openRowMenu(): HTMLButtonElement[] {
    const trigger = fixture.debugElement
      .queryAll(By.css('tbody button'))
      .find((el) =>
        (el.nativeElement as HTMLElement).getAttribute('aria-label')?.startsWith('Actions for')
      )!;
    (trigger.nativeElement as HTMLButtonElement).click();
    fixture.detectChanges();
    return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  }

  /** `ui-action-menu` emits one macrotask after the click, so the menu
   * has closed and returned focus before a dialog opens. */
  async function chooseAction(label: string): Promise<void> {
    const item = openRowMenu().find((el) => el.textContent?.trim() === label)!;
    item.click();
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
  }

  function typeSearch(value: string): void {
    const input = fixture.debugElement.query(By.css('input[type="search"]'))
      .nativeElement as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  beforeEach(async () => {
    localStorage.clear();
    apiClientStub.PATCH.calls.reset();
    await render(['client-admin:access', 'scheduling.view', 'scheduling.manage']);
  });

  afterEach(() => {
    localStorage.clear();
    fixture.destroy();
  });

  it('scopes the query to the active Business on init', () => {
    expect(store.updateQuery).toHaveBeenCalledWith({ business: 'biz-1' });
  });

  it('shows the empty state when the store has no rows and nothing is filtered', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No schedules yet');
  });

  it('renders the route name from the row itself, not a shared store', () => {
    // `route_name` was added to ScheduleSerializer for exactly this: the
    // screen used to resolve it through the root RouteStore, so a
    // schedule whose route sat outside that store's loaded page rendered
    // as a raw UUID.
    store.items.set([makeSchedule()]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Ikeja Express');
    expect(fixture.nativeElement.textContent).toContain('Mon/Wed/Fri');
  });

  // --- docs/specs/14 slice 3a: toggle becomes pill + confirmed action ---

  it('renders status as a read-only pill, with no switch in the table', () => {
    store.items.set([makeSchedule()]);
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('tbody [role="switch"]'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Active');
  });

  it('offers a manager Edit and Deactivate for an active schedule', () => {
    store.items.set([makeSchedule()]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).toEqual([
      'View details',
      'Edit',
      'Deactivate',
    ]);
  });

  it('gives a view-only user no write actions', async () => {
    await render(['client-admin:access', 'scheduling.view']);
    store.items.set([makeSchedule()]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).toEqual(['View details']);
  });

  it('confirms before deactivating rather than writing straight away', async () => {
    store.items.set([makeSchedule()]);
    fixture.detectChanges();
    await chooseAction('Deactivate');

    expect(dialogSpy.open).toHaveBeenCalled();
    expect(apiClientStub.PATCH).not.toHaveBeenCalled();

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toContain('Ikeja Express');
    expect(data.danger()).toBeTrue();
  });

  it('sends the flipped is_active only once the dialog confirms', async () => {
    store.items.set([makeSchedule()]);
    fixture.detectChanges();
    await chooseAction('Deactivate');

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    await data.onConfirm();

    expect(apiClientStub.PATCH).toHaveBeenCalledWith('/api/v1/schedules/{id}/', {
      params: { path: { id: 'sch-1' } },
      body: { is_active: false },
    });
  });

  it('opens a drawer of detail', async () => {
    store.items.set([makeSchedule()]);
    fixture.detectChanges();
    await chooseAction('View details');

    expect(drawerSpy.open).toHaveBeenCalled();
    expect(drawerSpy.open.calls.mostRecent().args[0].title).toBe('Ikeja Express');
  });

  // --- Filters ---

  it('sends a debounced search to the store, scoped to the active Business', fakeAsync(() => {
    store.updateQuery.calls.reset();
    typeSearch('Ikeja');
    expect(store.updateQuery).not.toHaveBeenCalled();

    tick(300);
    expect(store.updateQuery).toHaveBeenCalledWith({
      business: 'biz-1',
      search: 'Ikeja',
      is_active: undefined,
    });
  }));

  it('renders the active search as a removable chip', fakeAsync(() => {
    typeSearch('Ikeja');
    tick(300);
    fixture.detectChanges();

    const chip = fixture.debugElement
      .queryAll(By.css('button'))
      .find((el) =>
        (el.nativeElement as HTMLElement).getAttribute('aria-label')?.startsWith('Remove filter')
      );
    expect((chip!.nativeElement as HTMLElement).textContent).toContain('Search: Ikeja');
  }));

  it('says "no matches" rather than "none yet" when a filter is active', fakeAsync(() => {
    // The distinction matters: "No schedules yet" invites creating one,
    // when the real answer is to widen the filter.
    typeSearch('nothing matches');
    tick(300);
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No schedules match these filters');
    expect(fixture.nativeElement.textContent).not.toContain('No schedules yet');
  }));
  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makeSchedule()]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'schedule-list rows');
  });

  it('keeps the skeleton row aligned with the header too', () => {
    store.loading.set(true);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'schedule-list skeleton');
  });
});
