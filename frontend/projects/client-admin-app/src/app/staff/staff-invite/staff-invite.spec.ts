import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { StaffInvite } from './staff-invite';
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

describe('StaffInvite', () => {
  let fixture: ComponentFixture<StaffInvite>;
  let apiClient: { POST: jasmine.Spy };
  let roleOptionsService: jasmine.SpyObj<RoleOptionsService>;

  beforeEach(async () => {
    localStorage.clear();
    apiClient = { POST: jasmine.createSpy('POST') };
    roleOptionsService = jasmine.createSpyObj<RoleOptionsService>('RoleOptionsService', [
      'loadOptions',
    ]);
    roleOptionsService.loadOptions.and.resolveTo([
      { value: 'role-owner', label: 'Owner' },
      { value: 'role-manager', label: 'Manager' },
    ]);

    await TestBed.configureTestingModule({
      imports: [StaffInvite],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: apiClient },
        { provide: RoleOptionsService, useValue: roleOptionsService },
      ],
    }).compileComponents();

    const authStore = TestBed.inject(AuthStore);
    authStore.setSession('a', 'r', makeUser({ permissions: ['client-admin:access'] }));

    fixture = TestBed.createComponent(StaffInvite);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('loads role options and defaults the role control to the first option', () => {
    expect(fixture.componentInstance['form'].controls.role.value).toBe('role-owner');
  });

  it('does not submit an invalid form', async () => {
    fixture.componentInstance['form'].controls.email.setValue('');
    await fixture.componentInstance['onSubmit']();
    expect(apiClient.POST).not.toHaveBeenCalled();
  });

  it('shows an in-place success confirmation on success', async () => {
    apiClient.POST.and.resolveTo({ data: { id: 'inv-1' } });
    fixture.componentInstance['form'].setValue({
      email: 'newstaff@example.com',
      role: 'role-manager',
    });

    await fixture.componentInstance['onSubmit']();
    fixture.detectChanges();

    expect(fixture.componentInstance['invitedEmail']()).toBe('newstaff@example.com');
    expect(fixture.nativeElement.textContent).toContain('Invitation sent to newstaff@example.com');
  });

  it('shows the "already a member" error under the email field', async () => {
    apiClient.POST.and.resolveTo({
      error: { email: ['This person is already a member of your team.'] },
    });
    fixture.componentInstance['form'].setValue({
      email: 'existing@example.com',
      role: 'role-manager',
    });

    await fixture.componentInstance['onSubmit']();
    fixture.detectChanges();

    expect(fixture.componentInstance['fieldError']('email')).toBe(
      'This person is already a member of your team.'
    );
    expect(fixture.componentInstance['invitedEmail']()).toBeNull();
  });

  it('shows an unknown-role error under the role field', async () => {
    apiClient.POST.and.resolveTo({ error: { role: ['Unknown role.'] } });
    fixture.componentInstance['form'].setValue({
      email: 'newstaff@example.com',
      role: 'role-manager',
    });

    await fixture.componentInstance['onSubmit']();
    fixture.detectChanges();

    expect(fixture.componentInstance['fieldError']('role')).toBe('Unknown role.');
    // Rendered, not merely computed: ui-select shows nothing unless the
    // parent binds both `invalid` and `errorMessage`.
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Unknown role.');
  });

  it('resets the form and clears the confirmation on "Invite another"', async () => {
    apiClient.POST.and.resolveTo({ data: { id: 'inv-1' } });
    fixture.componentInstance['form'].setValue({
      email: 'newstaff@example.com',
      role: 'role-manager',
    });
    await fixture.componentInstance['onSubmit']();
    fixture.detectChanges();

    fixture.componentInstance['inviteAnother']();
    fixture.detectChanges();

    expect(fixture.componentInstance['invitedEmail']()).toBeNull();
    expect(fixture.componentInstance['form'].value.email).toBe('');
  });
});
