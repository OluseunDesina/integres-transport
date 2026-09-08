import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';

import { ClientInvite } from './client-invite';

describe('ClientInvite', () => {
  let fixture: ComponentFixture<ClientInvite>;
  let apiClient: { POST: jasmine.Spy };

  beforeEach(async () => {
    localStorage.clear();
    apiClient = { POST: jasmine.createSpy('POST') };

    await TestBed.configureTestingModule({
      imports: [ClientInvite],
      providers: [provideRouter([]), { provide: API_CLIENT, useValue: apiClient }],
    }).compileComponents();

    const authStore = TestBed.inject(AuthStore);
    authStore.setSession('a', 'r', {
      id: 'staff-1',
      email: 'platform@example.com',
      firstName: '',
      lastName: '',
      client: null,
      isPlatformStaff: true,
      isClientStaff: false,
      permissions: ['super-admin:access'],
      roleName: null,
      clientName: null,
    });

    fixture = TestBed.createComponent(ClientInvite);
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('does not submit an invalid (empty) form', async () => {
    await fixture.componentInstance['onSubmit']();
    expect(apiClient.POST).not.toHaveBeenCalled();
  });

  it('shows an in-place success confirmation on success', async () => {
    apiClient.POST.and.resolveTo({ data: { id: 'inv-1' } });
    fixture.componentInstance['form'].setValue({
      name: 'Acme Shuttle Co',
      email: 'owner@acme.example.com',
    });

    await fixture.componentInstance['onSubmit']();
    fixture.detectChanges();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/super-admin/client-invitations/',
      jasmine.objectContaining({
        body: { name: 'Acme Shuttle Co', email: 'owner@acme.example.com' },
      })
    );
    expect(fixture.componentInstance['invitedEmail']()).toBe('owner@acme.example.com');
    expect(fixture.nativeElement.textContent).toContain(
      'Invitation sent to owner@acme.example.com'
    );
  });

  it('shows a field-level error under email for a duplicate address', async () => {
    apiClient.POST.and.resolveTo({
      error: { email: ['A client with this email already exists.'] },
    });
    fixture.componentInstance['form'].setValue({
      name: 'Acme Shuttle Co',
      email: 'owner@acme.example.com',
    });

    await fixture.componentInstance['onSubmit']();
    fixture.detectChanges();

    expect(fixture.componentInstance['fieldError']('email')).toBe(
      'A client with this email already exists.'
    );
    // Rendered, not merely computed: ui-text-field shows nothing unless
    // the parent binds both `invalid` and `errorMessage`.
    expect(fixture.nativeElement.textContent).toContain(
      'A client with this email already exists.'
    );
    expect(fixture.componentInstance['invitedEmail']()).toBeNull();
  });

  it('shows a generic error banner for an unrecognized error shape', async () => {
    apiClient.POST.and.resolveTo({ error: {} });
    fixture.componentInstance['form'].setValue({
      name: 'Acme Shuttle Co',
      email: 'owner@acme.example.com',
    });

    await fixture.componentInstance['onSubmit']();
    fixture.detectChanges();

    expect(fixture.componentInstance['generalError']()).toBe(
      'Could not send this invitation. Try again.'
    );
  });

  it('resets the form and clears the confirmation on "Invite another"', async () => {
    apiClient.POST.and.resolveTo({ data: { id: 'inv-1' } });
    fixture.componentInstance['form'].setValue({
      name: 'Acme Shuttle Co',
      email: 'owner@acme.example.com',
    });
    await fixture.componentInstance['onSubmit']();
    fixture.detectChanges();

    fixture.componentInstance['inviteAnother']();
    fixture.detectChanges();

    expect(fixture.componentInstance['invitedEmail']()).toBeNull();
    expect(fixture.componentInstance['form'].value.email).toBe('');
    expect(fixture.componentInstance['form'].value.name).toBe('');
  });
});
