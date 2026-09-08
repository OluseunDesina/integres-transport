import { Dialog } from '@angular/cdk/dialog';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';
import { DrawerService, expectColumnVisibilityParity } from '@shared-ui';
import type { ConfirmDialogData } from '@shared-ui';
import { Subject } from 'rxjs';

import { VehicleList } from './vehicle-list';
import { BusinessStore, type Business } from '../../shared/data/store/business.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { VehicleStore, type Vehicle } from '../../shared/data/store/vehicle.store';

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

function makeVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    id: 'v-1',
    business: 'biz-1',
    vehicle_type: 'vt-1',
    registration_number: 'LAG-123-XY',
    insurance_expires_at: null,
    roadworthiness_expires_at: null,
    is_active: true,
    compliance_warnings: [],
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeVehicleStore {
  items = signal<Vehicle[]>([]);
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

describe('VehicleList', () => {
  let fixture: ComponentFixture<VehicleList>;
  let store: FakeVehicleStore;
  let dialogSpy: jasmine.SpyObj<Dialog>;
  let drawerSpy: jasmine.SpyObj<DrawerService>;
  let closedSubject: Subject<boolean | undefined>;

  /** Signs in with the given permissions and renders. Split out because
   * the manage/view-only distinction now changes which row actions
   * exist at all. */
  async function render(permissions: string[]): Promise<void> {
    // A test that re-renders with different permissions is reconfiguring
    // an already-instantiated TestBed, which throws.
    fixture?.destroy();
    TestBed.resetTestingModule();
    store = new FakeVehicleStore();
    closedSubject = new Subject<boolean | undefined>();
    dialogSpy = jasmine.createSpyObj<Dialog>('Dialog', ['open']);
    dialogSpy.open.and.returnValue({
      closed: closedSubject.asObservable(),
    } as ReturnType<Dialog['open']>);
    drawerSpy = jasmine.createSpyObj<DrawerService>('DrawerService', ['open']);

    await TestBed.configureTestingModule({
      imports: [VehicleList],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: apiClientStub },
        { provide: VehicleStore, useValue: store },
        { provide: BusinessStore, useValue: new FakeBusinessStore() },
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

    fixture = TestBed.createComponent(VehicleList);
    fixture.detectChanges();
  }

  /** Opens the row's action menu and returns its rendered menu items. */
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

  /**
   * `ui-action-menu` emits one macrotask after the click, so the CDK
   * menu has closed and returned focus before a consumer opens a dialog
   * or drawer — see its own docstring. Callers must await this.
   */
  async function chooseAction(label: string): Promise<void> {
    const item = openRowMenu().find((el) => el.textContent?.trim() === label)!;
    item.click();
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
  }

  beforeEach(async () => {
    localStorage.clear();
    apiClientStub.PATCH.calls.reset();
    await render(['client-admin:access', 'fleet.view', 'fleet.manage']);
  });

  afterEach(() => {
    localStorage.clear();
    fixture.destroy();
  });

  it('scopes the query to the active Business on init', () => {
    expect(store.updateQuery).toHaveBeenCalledWith({ business: 'biz-1' });
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No vehicles yet');
  });

  it('shows a "Compliant" pill when there are no warnings', () => {
    store.items.set([makeVehicle()]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Compliant');
  });

  it('shows a warning pill listing the compliance_warnings count', () => {
    store.items.set([
      makeVehicle({
        compliance_warnings: ['Vehicle insurance expired on 2026-01-01'],
      }),
    ]);
    fixture.detectChanges();

    const cells = fixture.debugElement.queryAll(By.css('tbody td'));
    expect(
      cells.some((c) => (c.nativeElement.textContent as string).includes('1 warning(s)'))
    ).toBe(true);
  });

  // --- docs/specs/14 slice 2: the in-table toggle becomes a status pill
  //     plus an explicit, confirmed action ---

  it('renders status as a read-only pill, with no switch in the table', () => {
    // The whole point of the change: a write control in a read surface
    // is one mis-tap from taking a vehicle out of service.
    store.items.set([makeVehicle()]);
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('tbody [role="switch"]'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Active');
  });

  it('shows the same read-only status to a viewer who cannot manage fleet', async () => {
    await render(['client-admin:access', 'fleet.view']);
    store.items.set([makeVehicle({ is_active: false })]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Inactive');
  });

  it('offers a manager Edit and Deactivate for an active vehicle', () => {
    store.items.set([makeVehicle()]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).toEqual([
      'View details',
      'Edit',
      'Deactivate',
    ]);
  });

  it('offers Activate instead when the vehicle is inactive', () => {
    store.items.set([makeVehicle({ is_active: false })]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).toContain('Activate');
  });

  it('gives a view-only user no write actions', async () => {
    // Same gating the Edit link carried before — a viewer must not be
    // offered a write they cannot perform.
    await render(['client-admin:access', 'fleet.view']);
    store.items.set([makeVehicle()]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).toEqual(['View details']);
  });

  it('names each row menu after its own vehicle', async () => {
    // A table of identically-named "Actions" buttons is unusable by
    // screen reader.
    store.items.set([makeVehicle({ registration_number: 'LAG-999-ZZ' })]);
    fixture.detectChanges();

    const trigger = fixture.debugElement
      .queryAll(By.css('tbody button'))
      .find((el) =>
        (el.nativeElement as HTMLElement).getAttribute('aria-label')?.startsWith('Actions for')
      )!;
    expect((trigger.nativeElement as HTMLElement).getAttribute('aria-label')).toBe(
      'Actions for LAG-999-ZZ'
    );
  });

  it('confirms before deactivating rather than writing straight away', async () => {
    store.items.set([makeVehicle()]);
    fixture.detectChanges();
    await chooseAction('Deactivate');

    expect(dialogSpy.open).toHaveBeenCalled();
    expect(apiClientStub.PATCH).not.toHaveBeenCalled();

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toBe('Deactivate LAG-123-XY?');
    expect(data.danger()).toBeTrue();
    expect(data.confirmLabel()).toBe('Deactivate');
  });

  it('does not treat activating as destructive', async () => {
    store.items.set([makeVehicle({ is_active: false })]);
    fixture.detectChanges();
    await chooseAction('Activate');

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toBe('Activate LAG-123-XY?');
    expect(data.danger()).toBeFalse();
  });

  it('sends the flipped is_active only once the dialog confirms', async () => {
    store.items.set([makeVehicle()]);
    fixture.detectChanges();
    await chooseAction('Deactivate');

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    await data.onConfirm();

    expect(apiClientStub.PATCH).toHaveBeenCalledWith('/api/v1/vehicles/{id}/', {
      params: { path: { id: 'v-1' } },
      body: { is_active: false },
    });
  });

  it('surfaces a rejected write inside the dialog instead of closing on it', async () => {
    // ConfirmDialog owns the submit lifecycle precisely so a server-side
    // rejection lands while the dialog is still open.
    apiClientStub.PATCH.and.resolveTo({
      error: { detail: 'Vehicle is on an active trip.' },
    });
    store.items.set([makeVehicle()]);
    fixture.detectChanges();
    await chooseAction('Deactivate');

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    const result = await data.onConfirm();

    expect(result).toEqual({
      ok: false,
      error: 'Vehicle is on an active trip.',
    });
    apiClientStub.PATCH.and.resolveTo({ data: {} });
  });

  it('refetches after a confirmed change, and not after a cancelled one', async () => {
    store.items.set([makeVehicle()]);
    fixture.detectChanges();

    // The clock goes in *after* the menu has settled — installing it
    // first would freeze ui-action-menu's own deferred emission too.
    await chooseAction('Deactivate');
    jasmine.clock().install();
    store.getAll.calls.reset();
    closedSubject.next(undefined);
    jasmine.clock().tick(1);
    expect(store.getAll).not.toHaveBeenCalled();

    closedSubject.next(true);
    jasmine.clock().tick(1);
    expect(store.getAll).toHaveBeenCalled();
    jasmine.clock().uninstall();
  });

  it('opens a drawer of detail rather than hiding warnings in a title tooltip', async () => {
    // The warnings used to be a `title` attribute: invisible on touch,
    // and not reliably announced.
    store.items.set([makeVehicle({ compliance_warnings: ['Insurance expired'] })]);
    fixture.detectChanges();
    await chooseAction('View details');

    expect(drawerSpy.open).toHaveBeenCalled();
    expect(drawerSpy.open.calls.mostRecent().args[0].title).toBe('LAG-123-XY');
    expect(fixture.debugElement.query(By.css('tbody [title]'))).toBeNull();
  });

  // --- Density ---

  it('renders skeleton rows while loading, hidden from assistive tech', () => {
    store.loading.set(true);
    fixture.detectChanges();

    expect(fixture.debugElement.queryAll(By.css('tbody .animate-pulse')).length).toBeGreaterThan(0);
    const region = fixture.debugElement.query(By.css('[aria-busy]'));
    expect((region.nativeElement as HTMLElement).getAttribute('aria-busy')).toBe('true');
  });

  it('tightens row padding in compact density', () => {
    store.items.set([makeVehicle()]);
    fixture.detectChanges();
    const paddingOf = () =>
      (fixture.debugElement.query(By.css('tbody td')).nativeElement as HTMLElement).className;

    expect(paddingOf()).toContain('py-3');

    const compact = fixture.debugElement
      .queryAll(By.css('button'))
      .find(
        (el) => (el.nativeElement as HTMLElement).getAttribute('aria-label') === 'Compact rows'
      )!;
    (compact.nativeElement as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(paddingOf()).toContain('py-1');
  });

  it('shrinks the row controls too, not only the padding', () => {
    // Padding alone left compact at 48px against comfortable's 60px,
    // because ui-action-menu's token-sized trigger sets the floor — a
    // density control that visibly did almost nothing. Compact overrides
    // the control-height token for the table instead.
    store.items.set([makeVehicle()]);
    fixture.detectChanges();
    const region = () =>
      fixture.debugElement.query(By.css('[aria-busy]')).nativeElement as HTMLElement;

    expect(region().getAttribute('style')).toBeNull();

    const compact = fixture.debugElement
      .queryAll(By.css('button'))
      .find(
        (el) => (el.nativeElement as HTMLElement).getAttribute('aria-label') === 'Compact rows'
      )!;
    (compact.nativeElement as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(region().style.getPropertyValue('--ui-control-height')).toBe('1.75rem');
  });

  it('remembers the density preference across visits', async () => {
    const compact = fixture.debugElement
      .queryAll(By.css('button'))
      .find(
        (el) => (el.nativeElement as HTMLElement).getAttribute('aria-label') === 'Compact rows'
      )!;
    (compact.nativeElement as HTMLButtonElement).click();
    fixture.detectChanges();

    await render(['client-admin:access', 'fleet.view', 'fleet.manage']);
    const stillCompact = fixture.debugElement
      .queryAll(By.css('button'))
      .find(
        (el) => (el.nativeElement as HTMLElement).getAttribute('aria-label') === 'Compact rows'
      )!;
    expect((stillCompact.nativeElement as HTMLElement).getAttribute('aria-pressed')).toBe('true');
  });
  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makeVehicle()]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'vehicle-list rows');
  });

  it('keeps the skeleton row aligned with the header too', () => {
    store.loading.set(true);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'vehicle-list skeleton');
  });
});
