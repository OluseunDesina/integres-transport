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

import { DriverList } from './driver-list';
import { BusinessStore, type Business } from '../../shared/data/store/business.store';
import { DriverStore, type Driver } from '../../shared/data/store/driver.store';
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
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  updateQuery = jasmine.createSpy('updateQuery').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

class FakeBusinessStore {
  items = signal<Business[]>([]);
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

const apiClientStub = {
  GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
  POST: jasmine.createSpy('POST').and.resolveTo({ data: {} }),
  PATCH: jasmine.createSpy('PATCH').and.resolveTo({ data: {} }),
};

describe('DriverList', () => {
  let fixture: ComponentFixture<DriverList>;
  let store: FakeDriverStore;

  let dialogSpy: jasmine.SpyObj<Dialog>;
  let drawerSpy: jasmine.SpyObj<DrawerService>;
  let closedSubject: Subject<boolean | undefined>;
  let authStore: AuthStore;

  beforeEach(async () => {
    localStorage.clear();
    apiClientStub.PATCH.calls.reset();
    closedSubject = new Subject<boolean | undefined>();
    dialogSpy = jasmine.createSpyObj<Dialog>('Dialog', ['open']);
    dialogSpy.open.and.returnValue({
      closed: closedSubject.asObservable(),
    } as ReturnType<Dialog['open']>);
    drawerSpy = jasmine.createSpyObj<DrawerService>('DrawerService', ['open']);
    store = new FakeDriverStore();

    await TestBed.configureTestingModule({
      imports: [DriverList],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: apiClientStub },
        { provide: Dialog, useValue: dialogSpy },
        { provide: DrawerService, useValue: drawerSpy },
        { provide: DriverStore, useValue: store },
        { provide: BusinessStore, useValue: new FakeBusinessStore() },
        {
          provide: SelectedBusinessStore,
          useValue: new FakeSelectedBusinessStore(),
        },
      ],
    }).compileComponents();

    authStore = TestBed.inject(AuthStore);
    authStore.setSession(
      'a',
      'r',
      makeUser({ permissions: ['client-admin:access', 'fleet.view'] })
    );

    fixture = TestBed.createComponent(DriverList);
    fixture.detectChanges();
  });

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

    expect(fixture.nativeElement.textContent).toContain('No drivers yet');
  });

  it('renders a row per driver', () => {
    store.items.set([makeDriver(), makeDriver({ id: 'd-2', name: 'Chidi Okoye' })]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0].nativeElement.textContent).toContain('Tunde Bello');
  });

  it('shows a warning pill listing the compliance_warnings count', () => {
    store.items.set([
      makeDriver({
        compliance_warnings: ["Driver's license expired on 2026-01-01"],
      }),
    ]);
    fixture.detectChanges();

    const cells = fixture.debugElement.queryAll(By.css('tbody td'));
    expect(
      cells.some((c) => (c.nativeElement.textContent as string).includes('1 warning(s)'))
    ).toBe(true);
  });

  // --- docs/specs/14 slice 3a: toggle becomes pill + confirmed action ---

  it('renders status as a read-only pill, with no switch in the table', () => {
    // A write control in a read surface is one mis-tap from a change
    // nobody confirmed.
    store.items.set([makeDriver()]);
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('tbody [role="switch"]'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Active');
  });

  it('offers a manager Edit and Deactivate for an active row', () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({
        permissions: ['client-admin:access', 'fleet.view', 'fleet.manage'],
      })
    );
    store.items.set([makeDriver()]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).toEqual([
      'View details',
      'Edit',
      'Deactivate',
    ]);
  });

  it('gives a view-only user no write actions', () => {
    store.items.set([makeDriver()]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).toEqual(['View details']);
  });

  it('confirms before deactivating, and writes only once confirmed', async () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({
        permissions: ['client-admin:access', 'fleet.view', 'fleet.manage'],
      })
    );
    store.items.set([makeDriver()]);
    fixture.detectChanges();

    await chooseAction('Deactivate');
    expect(dialogSpy.open).toHaveBeenCalled();
    expect(apiClientStub.PATCH).not.toHaveBeenCalled();

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.danger()).toBeTrue();
    await data.onConfirm();

    expect(apiClientStub.PATCH).toHaveBeenCalledWith('/api/v1/drivers/{id}/', {
      params: { path: { id: 'd-1' } },
      body: { is_active: false },
    });
  });

  it('opens a drawer of detail', async () => {
    store.items.set([makeDriver()]);
    fixture.detectChanges();
    await chooseAction('View details');

    expect(drawerSpy.open).toHaveBeenCalled();
    expect(drawerSpy.open.calls.mostRecent().args[0].title).toBe('Tunde Bello');
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

  it('says "no matches" rather than "none yet" when a filter is active', fakeAsync(() => {
    typeSearch('nothing matches');
    tick(300);
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('match these filters');
  }));
  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makeDriver()]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'driver-list rows');
  });

  it('keeps the skeleton row aligned with the header too', () => {
    store.loading.set(true);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'driver-list skeleton');
  });
});
