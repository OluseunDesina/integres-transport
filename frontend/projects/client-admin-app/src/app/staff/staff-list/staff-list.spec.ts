import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

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
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

describe('StaffList', () => {
  let fixture: ComponentFixture<StaffList>;
  let store: FakeStaffStore;
  let authStore: AuthStore;
  let apiClient: { PATCH: jasmine.Spy };
  let roleOptionsService: jasmine.SpyObj<RoleOptionsService>;

  beforeEach(async () => {
    localStorage.clear();
    store = new FakeStaffStore();
    apiClient = { PATCH: jasmine.createSpy('PATCH') };
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
      ],
    }).compileComponents();

    authStore = TestBed.inject(AuthStore);
    authStore.setSession(
      'a',
      'r',
      makeUser({ permissions: ['client-admin:access', 'staff.manage', 'staff.invite'] })
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

  it('renders a row per staff member with email, role select, and active checkbox', () => {
    store.items.set([makeStaff()]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(1);
    expect(rows[0].nativeElement.textContent).toContain('staff@example.com');
    expect(rows[0].query(By.css('select'))).not.toBeNull();
    expect(rows[0].query(By.css('input[type="checkbox"]'))).not.toBeNull();
  });

  it('PATCHes the role and refetches on role change', async () => {
    store.items.set([makeStaff()]);
    fixture.detectChanges();
    apiClient.PATCH.and.resolveTo({ data: makeStaff({ role: { id: 'role-manager', name: 'Manager', permissions: [] } }) });
    store.getAll.calls.reset();

    const select = fixture.debugElement.query(By.css('select')).nativeElement as HTMLSelectElement;
    select.value = 'role-manager';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    expect(apiClient.PATCH).toHaveBeenCalledWith(
      '/api/v1/staff/{user_id}/',
      jasmine.objectContaining({
        params: { path: { user_id: 'staff-1' } },
        body: { role: 'role-manager' },
      })
    );
    expect(store.getAll).toHaveBeenCalled();
  });

  it('PATCHes is_active and refetches on checkbox change', async () => {
    store.items.set([makeStaff({ is_active: true })]);
    fixture.detectChanges();
    apiClient.PATCH.and.resolveTo({ data: makeStaff({ is_active: false }) });
    store.getAll.calls.reset();

    const checkbox = fixture.debugElement.query(By.css('input[type="checkbox"]'))
      .nativeElement as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    expect(apiClient.PATCH).toHaveBeenCalledWith(
      '/api/v1/staff/{user_id}/',
      jasmine.objectContaining({ body: { is_active: false } })
    );
    expect(store.getAll).toHaveBeenCalled();
  });

  it('shows an error alert when the PATCH fails, without refetching', async () => {
    store.items.set([makeStaff()]);
    fixture.detectChanges();
    apiClient.PATCH.and.resolveTo({ error: { detail: 'Forbidden.' } });
    store.getAll.calls.reset();

    const select = fixture.debugElement.query(By.css('select')).nativeElement as HTMLSelectElement;
    select.value = 'role-manager';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Forbidden.');
    expect(store.getAll).not.toHaveBeenCalled();
  });

  it('hides "Invite staff" without staff.invite permission', () => {
    authStore.setSession('a', 'r', makeUser({ permissions: ['client-admin:access', 'staff.manage'] }));
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
});
