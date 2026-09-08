import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthApiService } from '@auth';

import { StaffInviteAccept } from './staff-invite-accept';

async function setup(getResult: { data?: unknown; error?: unknown }) {
  const apiClient = { GET: jasmine.createSpy('GET').and.resolveTo(getResult) };
  const authApi = jasmine.createSpyObj<AuthApiService>('AuthApiService', [
    'acceptStaffInvitation',
    'login',
    'register',
    'logout',
  ]);

  await TestBed.configureTestingModule({
    imports: [StaffInviteAccept],
    providers: [
      provideRouter([]),
      { provide: API_CLIENT, useValue: apiClient },
      { provide: AuthApiService, useValue: authApi },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap({ token: 'tok-1' }) } },
      },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(StaffInviteAccept);
  return { fixture, apiClient, authApi };
}

describe('StaffInviteAccept', () => {
  let fixture: ComponentFixture<StaffInviteAccept>;
  let authApi: jasmine.SpyObj<AuthApiService>;

  describe('a pending invitation', () => {
    beforeEach(async () => {
      ({ fixture, authApi } = await setup({
        data: { client_name: 'Acme Shuttle Co', role_name: 'Staff', status: 'pending' },
      }));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    });

    it('renders the client and role name', () => {
      expect(fixture.nativeElement.textContent).toContain('Acme Shuttle Co');
      expect(fixture.nativeElement.textContent).toContain('Staff');
    });

    it('rejects a form where the passwords do not match', async () => {
      fixture.componentInstance['form'].setValue({
        password: 'a-strong-unguessable-passphrase-42',
        confirmPassword: 'something-else',
      });

      await fixture.componentInstance['onSubmit']();

      expect(authApi.acceptStaffInvitation).not.toHaveBeenCalled();
      expect(fixture.componentInstance['fieldError']('confirmPassword')).toBe(
        'Passwords do not match.'
      );
    });

    it('accepts the invitation and navigates to /home on success', async () => {
      const router = TestBed.inject(Router);
      const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);
      authApi.acceptStaffInvitation.and.resolveTo({ ok: true });
      fixture.componentInstance['form'].setValue({
        password: 'a-strong-unguessable-passphrase-42',
        confirmPassword: 'a-strong-unguessable-passphrase-42',
      });

      await fixture.componentInstance['onSubmit']();

      expect(authApi.acceptStaffInvitation).toHaveBeenCalledWith(
        'tok-1',
        'a-strong-unguessable-passphrase-42'
      );
      expect(navigateSpy).toHaveBeenCalledWith(['/home']);
    });
  });

  it('shows a message and no form for a revoked invitation', async () => {
    ({ fixture } = await setup({
      data: { client_name: 'Acme', role_name: 'Staff', status: 'revoked' },
    }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('has been revoked');
    expect(fixture.nativeElement.querySelector('form')).toBeNull();
  });

  it('shows a not-found message for an unknown token', async () => {
    ({ fixture } = await setup({ error: { detail: 'Not found.' } }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // The server's own words are deliberately **not** shown:
    // `get_object_or_404` produces "No StaffInvitation matches the given
    // query.", Django's internal phrasing naming the model class, and
    // this screen rendered it verbatim to whoever clicked a stale invite
    // link (spec 14 slice 6b, iteration-20 F2).
    expect(fixture.nativeElement.textContent).toContain('This invitation link is not valid.');
    expect(fixture.nativeElement.textContent).not.toContain('Not found.');
  });
});
