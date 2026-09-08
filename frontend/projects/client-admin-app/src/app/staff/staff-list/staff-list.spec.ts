import { Dialog } from '@angular/cdk/dialog';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { expectColumnVisibilityParity } from '@shared-ui';
import type { AuthUser } from '@auth';
import type { ConfirmDialogData } from '@shared-ui';
import { Subject } from 'rxjs';

import { StaffList } from './staff-list';
import { StaffStore, type Staff } from '../../shared/data/store/staff.store';
import { RoleOptionsService } from '../role-options.service';

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

function makeStaff(overrides: Partial<Staff> = {}): Staff {
  return {
    id: 'staff-1',
    email: 'staff@example.com',
    first_name: '',
    last_name: '',
    role: { id: 'role-owner', name: 'Owner', permissions: [] },
    is_active: true,
    ...overrides,
  };
}

class FakeStaffStore {
  items = signal<Staff[]>([]);
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  updateQuery = jasmine.createSpy('updateQuery').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

describe('StaffList', () => {
  let fixture: ComponentFixture<StaffList>;
  let store: FakeStaffStore;
  let authStore: AuthStore;
  let apiClient: { PATCH: jasmine.Spy };
  let roleOptionsService: jasmine.SpyObj<RoleOptionsService>;
  let dialogSpy: jasmine.SpyObj<Dialog>;
  let closedSubject: Subject<boolean | undefined>;

  beforeEach(async () => {
    localStorage.clear();
    store = new FakeStaffStore();
    apiClient = { PATCH: jasmine.createSpy('PATCH') };
    closedSubject = new Subject<boolean | undefined>();
    dialogSpy = jasmine.createSpyObj<Dialog>('Dialog', ['open']);
    dialogSpy.open.and.returnValue({
      closed: closedSubject.asObservable(),
    } as ReturnType<Dialog['open']>);
    roleOptionsService = jasmine.createSpyObj<RoleOptionsService>('RoleOptionsService', [
      'loadOptions',
    ]);
    roleOptionsService.loadOptions.and.resolveTo([
      { value: 'role-owner', label: 'Owner' },
      { value: 'role-manager', label: 'Manager' },
    ]);

    await TestBed.configureTestingModule({
      imports: [StaffList],
      providers: [
        provideRouter([]),
        { provide: StaffStore, useValue: store },
        { provide: API_CLIENT, useValue: apiClient },
        { provide: RoleOptionsService, useValue: roleOptionsService },
        { provide: Dialog, useValue: dialogSpy },
      ],
    }).compileComponents();

    authStore = TestBed.inject(AuthStore);
    authStore.setSession(
      'a',
      'r',
      makeUser({
        permissions: ['client-admin:access', 'staff.manage', 'staff.invite'],
      })
    );

    fixture = TestBed.createComponent(StaffList);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('calls getAll() and loads role options on init', () => {
    expect(store.getAll).toHaveBeenCalled();
    expect(roleOptionsService.loadOptions).toHaveBeenCalled();
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No staff yet');
  });

  // --- docs/specs/14 slice 3b: two in-row write controls become
  //     confirmed row-menu actions ---

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

  /** `ui-action-menu` emits one macrotask after the click. */
  async function chooseAction(label: string): Promise<void> {
    const item = openRowMenu().find((el) => el.textContent?.trim() === label)!;
    item.click();
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
  }

  it('renders role and status read-only, with no select or checkbox in the row', () => {
    // Both used to write on a single interaction. The role one is the
    // worse of the two: a mis-tap rewrote a colleague's permissions.
    store.items.set([makeStaff()]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(1);
    expect(rows[0].nativeElement.textContent).toContain('staff@example.com');
    expect(rows[0].nativeElement.textContent).toContain('Owner');
    expect(rows[0].query(By.css('select'))).toBeNull();
    expect(rows[0].query(By.css('input[type="checkbox"]'))).toBeNull();
  });

  it('confirms a role change rather than writing on selection', async () => {
    store.items.set([makeStaff()]);
    fixture.detectChanges();

    await chooseAction('Change role');

    expect(dialogSpy.open).toHaveBeenCalled();
    expect(apiClient.PATCH).not.toHaveBeenCalled();
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toBe('Change role for staff@example.com?');
  });

  it('blocks confirming a role change that changes nothing', async () => {
    // The dialog seeds from the member's current role, so confirming
    // without touching it would be a pointless write.
    store.items.set([makeStaff()]);
    fixture.detectChanges();
    await chooseAction('Change role');

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.confirmDisabled()).toBeTrue();

    fixture.componentInstance['onPendingRoleChange']('role-manager');
    expect(data.confirmDisabled()).toBeFalse();
  });

  it('PATCHes the chosen role once the dialog confirms', async () => {
    store.items.set([makeStaff()]);
    fixture.detectChanges();
    apiClient.PATCH.and.resolveTo({
      data: makeStaff({
        role: { id: 'role-manager', name: 'Manager', permissions: [] },
      }),
    });
    await chooseAction('Change role');

    fixture.componentInstance['onPendingRoleChange']('role-manager');
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(await data.onConfirm()).toEqual({ ok: true });

    expect(apiClient.PATCH).toHaveBeenCalledWith(
      '/api/v1/staff/{user_id}/',
      jasmine.objectContaining({
        params: { path: { user_id: 'staff-1' } },
        body: { role: 'role-manager' },
      })
    );
  });

  it('confirms deactivation and PATCHes the flipped flag', async () => {
    store.items.set([makeStaff({ is_active: true })]);
    fixture.detectChanges();
    apiClient.PATCH.and.resolveTo({ data: makeStaff({ is_active: false }) });

    await chooseAction('Deactivate');
    expect(apiClient.PATCH).not.toHaveBeenCalled();

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.danger()).toBeTrue();
    await data.onConfirm();

    expect(apiClient.PATCH).toHaveBeenCalledWith(
      '/api/v1/staff/{user_id}/',
      jasmine.objectContaining({ body: { is_active: false } })
    );
  });

  it('surfaces a rejected write inside the dialog instead of closing on it', async () => {
    store.items.set([makeStaff()]);
    fixture.detectChanges();
    apiClient.PATCH.and.resolveTo({ error: { detail: 'Forbidden.' } });
    store.getAll.calls.reset();

    await chooseAction('Deactivate');
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;

    expect(await data.onConfirm()).toEqual({ ok: false, error: 'Forbidden.' });
    expect(store.getAll).not.toHaveBeenCalled();
  });

  it('offers a member no way to change or deactivate themselves', async () => {
    // The backend rejects it anyway; offering an action that always
    // fails is worse than not offering it, and locking yourself out of
    // your own console is the accident worth making impossible.
    store.items.set([makeStaff({ id: 'user-1', email: 'owner@example.com' })]);
    fixture.detectChanges();

    const disabled = openRowMenu().map((el) => el.getAttribute('aria-disabled'));
    expect(disabled).toEqual(['true', 'true']);
  });

  it('hides "Invite staff" without staff.invite permission', () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({ permissions: ['client-admin:access', 'staff.manage'] })
    );
    fixture.detectChanges();

    const buttons = fixture.debugElement
      .queryAll(By.css('button'))
      .map((el) => (el.nativeElement.textContent as string).trim());
    expect(buttons).not.toContain('Invite staff');
  });

  it('navigates to /staff/invite when "Invite staff" is pressed', async () => {
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

    const button = fixture.debugElement
      .queryAll(By.css('button'))
      .find((el) => (el.nativeElement.textContent as string).trim() === 'Invite staff');
    button?.nativeElement.click();
    await fixture.whenStable();

    expect(navigateSpy).toHaveBeenCalledWith(['/staff/invite']);
  });
  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makeStaff()]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'staff-list rows');
  });

  it('keeps the skeleton row aligned with the header too', () => {
    store.loading.set(true);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'staff-list skeleton');
  });
});
