import { ComponentFixture, TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { WhiteLabel } from './white-label';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
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

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wl-1',
    domain: 'acme.example.com',
    logo: 'https://acme.example.com/logo.png',
    primary_color: '#111111',
    secondary_color: '#eeeeee',
    email_sender_name: 'Acme Shuttle',
    email_sender_address: 'noreply@acme.example.com',
    terms_url: 'https://acme.example.com/terms',
    ...overrides,
  };
}

async function setup() {
  const apiClient = { GET: jasmine.createSpy('GET'), PATCH: jasmine.createSpy('PATCH') };

  await TestBed.configureTestingModule({
    imports: [WhiteLabel],
    providers: [{ provide: API_CLIENT, useValue: apiClient }],
  }).compileComponents();

  const authStore = TestBed.inject(AuthStore);
  authStore.setSession('access-token', 'refresh-token', makeUser());

  const fixture = TestBed.createComponent(WhiteLabel);
  return { fixture, apiClient };
}

describe('WhiteLabel', () => {
  let fixture: ComponentFixture<WhiteLabel>;
  let apiClient: { GET: jasmine.Spy; PATCH: jasmine.Spy };

  it('loads and populates the form from the current config', async () => {
    ({ fixture, apiClient } = await setup());
    apiClient.GET.and.resolveTo({ data: makeConfig() });

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance['form'].value.domain).toBe('acme.example.com');
    expect(fixture.componentInstance['form'].value.email_sender_address).toBe(
      'noreply@acme.example.com'
    );
  });

  it('shows a load error when the fetch fails', async () => {
    ({ fixture, apiClient } = await setup());
    apiClient.GET.and.resolveTo({ error: {} });

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Could not load white-label settings.');
  });

  it('does not submit an invalid (empty domain) form', async () => {
    ({ fixture, apiClient } = await setup());
    apiClient.GET.and.resolveTo({ data: makeConfig() });
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentInstance['form'].patchValue({ domain: '' });
    await fixture.componentInstance['onSubmit']();

    expect(apiClient.PATCH).not.toHaveBeenCalled();
  });

  it('saves changes and shows a confirmation message', async () => {
    ({ fixture, apiClient } = await setup());
    apiClient.GET.and.resolveTo({ data: makeConfig() });
    fixture.detectChanges();
    await fixture.whenStable();

    apiClient.PATCH.and.resolveTo({ data: makeConfig({ primary_color: '#222222' }) });
    fixture.componentInstance['form'].patchValue({ primary_color: '#222222' });

    await fixture.componentInstance['onSubmit']();
    fixture.detectChanges();

    expect(apiClient.PATCH).toHaveBeenCalledWith(
      '/api/v1/white-label/',
      jasmine.objectContaining({ body: jasmine.objectContaining({ primary_color: '#222222' }) })
    );
    expect(fixture.componentInstance['saved']()).toBeTrue();
  });

  it('shows the server error message on failure', async () => {
    ({ fixture, apiClient } = await setup());
    apiClient.GET.and.resolveTo({ data: makeConfig() });
    fixture.detectChanges();
    await fixture.whenStable();

    apiClient.PATCH.and.resolveTo({
      error: { domain: ['This domain is already in use.'] },
    });

    await fixture.componentInstance['onSubmit']();
    fixture.detectChanges();

    // Rendered under the Domain field. Seven text fields on this screen
    // and the old alert named none of them. Note the form renders here
    // for the first time — the message has to survive the control being
    // bound, which is why it does not live only in `control.errors`.
    const error = (fixture.nativeElement as HTMLElement).querySelector(
      'ui-text-field [role="alert"]',
    );
    expect(error?.textContent?.trim()).toBe('This domain is already in use.');
    expect(fixture.componentInstance['errorMessage']()).toBeNull();
  });

  it('reports an empty domain as missing rather than as a bad email address', async () => {
    // The previous `fieldError` returned "Enter a valid email address."
    // for whichever of its two fields was not `domain`, and "This field
    // is required." for `domain` — so a malformed sender address read as
    // missing and a missing domain could read as malformed.
    ({ fixture, apiClient } = await setup());
    apiClient.GET.and.resolveTo({ data: makeConfig() });
    fixture.detectChanges();
    await fixture.whenStable();

    const form = fixture.componentInstance['form'];
    form.controls.domain.setValue('');
    form.controls.email_sender_address.setValue('not-an-email');
    form.markAllAsTouched();
    fixture.detectChanges();

    const errors = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('ui-text-field [role="alert"]'),
    ).map((el) => el.textContent?.trim());
    expect(errors).toContain('This field is required.');
    expect(errors).toContain('Enter a valid email address.');
  });
});
