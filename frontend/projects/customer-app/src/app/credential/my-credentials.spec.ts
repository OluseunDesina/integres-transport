import { Dialog } from '@angular/cdk/dialog';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { ConfirmDialogData } from '@shared-ui';
import { API_CLIENT } from '@api-client';
import { Subject } from 'rxjs';

import { MyCredentials } from './my-credentials';

interface WithGenerateQr {
  generateQrDataUrl(token: string): Promise<string>;
}

function makeCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-1',
    channel: 'qr',
    label: 'My phone',
    is_active: true,
    created_at: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

describe('MyCredentials', () => {
  let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy; PATCH: jasmine.Spy };
  let dialog: { open: jasmine.Spy };
  let closed: Subject<boolean>;
  let fixture: ComponentFixture<MyCredentials>;
  let component: MyCredentials;

  async function createComponent(): Promise<void> {
    fixture = TestBed.createComponent(MyCredentials);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function lastDialogData(): ConfirmDialogData {
    return dialog.open.calls.mostRecent().args[1].data as ConfirmDialogData;
  }

  beforeEach(() => {
    apiClient = {
      GET: jasmine
        .createSpy('GET')
        .and.resolveTo({ data: { count: 1, results: [makeCredential()] } }),
      POST: jasmine.createSpy('POST'),
      PATCH: jasmine.createSpy('PATCH').and.resolveTo({ data: makeCredential({ is_active: false }) }),
    };
    closed = new Subject<boolean>();
    dialog = { open: jasmine.createSpy('open').and.returnValue({ closed }) };

    TestBed.configureTestingModule({
      imports: [MyCredentials],
      providers: [
        { provide: API_CLIENT, useValue: apiClient },
        { provide: Dialog, useValue: dialog },
      ],
    });
  });

  it("loads the passenger's own credentials on init", async () => {
    await createComponent();

    expect(apiClient.GET).toHaveBeenCalledWith('/api/v1/tap-credentials/mine/', jasmine.anything());
    expect(component['store'].items().length).toBe(1);
  });

  it('shows an empty state before any credential exists', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await createComponent();

    expect((fixture.nativeElement as HTMLElement).querySelector('ui-empty-state')).toBeTruthy();
  });

  it('renders a row per credential with channel, label, and status', async () => {
    await createComponent();

    const cells = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr td')
    ).map((td) => td.textContent?.trim());
    expect(cells[0]).toBe('QR code');
    expect(cells[1]).toBe('My phone');
    const pill = (fixture.nativeElement as HTMLElement).querySelector('ui-status-pill');
    expect(pill?.textContent?.trim()).toBe('Active');
  });

  it('shows the token and QR code exactly once on successful issuance', async () => {
    await createComponent();
    apiClient.POST.and.resolveTo({
      data: { id: 'cred-2', token: 'raw-token-xyz', channel: 'qr', label: '', is_active: true, created_at: '2026-08-17T00:00:00Z' },
    });
    spyOn(component as unknown as WithGenerateQr, 'generateQrDataUrl').and.resolveTo('data:image/png;base64,fake');

    await component['onIssue']();
    fixture.detectChanges();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/tap-credentials/',
      jasmine.objectContaining({ body: { channel: 'qr', label: '' } })
    );
    expect(component['issuedCredential']()?.token).toBe('raw-token-xyz');
    const code = (fixture.nativeElement as HTMLElement).querySelector('code');
    expect(code?.textContent?.trim()).toBe('raw-token-xyz');
    const img = (fixture.nativeElement as HTMLElement).querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,fake');
  });

  it('clears the reveal when dismissed', async () => {
    await createComponent();
    apiClient.POST.and.resolveTo({
      data: { id: 'cred-2', token: 'raw-token-xyz', channel: 'qr', label: '', is_active: true, created_at: '2026-08-17T00:00:00Z' },
    });
    spyOn(component as unknown as WithGenerateQr, 'generateQrDataUrl').and.resolveTo('data:image/png;base64,fake');
    await component['onIssue']();

    component['dismissReveal']();
    fixture.detectChanges();

    expect(component['issuedCredential']()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('code')).toBeNull();
  });

  it('shows the server message when issuance fails', async () => {
    await createComponent();
    apiClient.POST.and.resolveTo({ error: { detail: 'Too many active credentials.' } });

    await component['onIssue']();
    fixture.detectChanges();

    expect(component['issueError']()).toBe('Too many active credentials.');
    expect((fixture.nativeElement as HTMLElement).querySelector('ui-alert')?.textContent?.trim()).toBe(
      'Too many active credentials.'
    );
  });

  it('does not render a revoke action on an already-revoked credential', async () => {
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeCredential({ is_active: false })] },
    });

    await createComponent();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('tbody tr td:last-child ui-button')
    ).toBeNull();
  });

  it('revokes a credential through the confirm dialog', async () => {
    await createComponent();

    component['revoke'](makeCredential() as never);
    const result = await lastDialogData().onConfirm();

    expect(apiClient.PATCH).toHaveBeenCalledWith(
      '/api/v1/tap-credentials/{id}/',
      jasmine.objectContaining({ params: { path: { id: 'cred-1' } }, body: { is_active: false } })
    );
    expect(result).toEqual({ ok: true });
  });

  it('refetches after the revoke dialog closes, deferred a tick', async () => {
    await createComponent();
    apiClient.GET.calls.reset();

    component['revoke'](makeCredential() as never);
    closed.next(true);

    expect(apiClient.GET).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiClient.GET).toHaveBeenCalled();
  });
});
