import { ComponentFixture, TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { KycStatus } from './kyc-status';

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

describe('KycStatus', () => {
  let fixture: ComponentFixture<KycStatus>;
  let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy };

  async function setup(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [KycStatus],
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    }).compileComponents();

    const authStore = TestBed.inject(AuthStore);
    authStore.setSession('a', 'r', makeUser({ permissions: ['client-admin:access', 'client.view'] }));

    fixture = TestBed.createComponent(KycStatus);
  }

  beforeEach(() => {
    localStorage.clear();
    apiClient = { GET: jasmine.createSpy('GET'), POST: jasmine.createSpy('POST') };
  });

  afterEach(() => localStorage.clear());

  it('loads and renders the status, submitted date, and documents', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        kyc_status: 'submitted',
        kyc_submitted_at: '2026-08-06T00:00:00Z',
        kyc_rejection_reason: '',
        documents: [
          { id: 'doc-1', document_type: 'certificate_of_incorporation', file: '/media/cert.pdf', status: 'pending', created_at: '2026-08-06T00:00:00Z' },
        ],
      },
    });
    await setup();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('submitted');
    expect(fixture.nativeElement.textContent).toContain('certificate_of_incorporation');
  });

  it('shows the rejection reason when rejected', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        kyc_status: 'rejected',
        kyc_submitted_at: '2026-08-06T00:00:00Z',
        kyc_rejection_reason: 'Certificate illegible.',
        documents: [],
      },
    });
    await setup();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Certificate illegible.');
  });

  it('shows an empty-documents message when there are none', async () => {
    apiClient.GET.and.resolveTo({
      data: { kyc_status: 'pending', kyc_submitted_at: null, kyc_rejection_reason: '', documents: [] },
    });
    await setup();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No documents uploaded yet.');
  });

  it('shows a load error', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });
    await setup();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Forbidden.');
  });

  it('requires a file before uploading', async () => {
    apiClient.GET.and.resolveTo({
      data: { kyc_status: 'pending', kyc_submitted_at: null, kyc_rejection_reason: '', documents: [] },
    });
    await setup();
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance['onUpload']();

    expect(apiClient.POST).not.toHaveBeenCalled();
    expect(fixture.componentInstance['uploadError']()).toBe('Choose a file to upload.');
  });

  it('uploads the selected file and refetches on success', async () => {
    apiClient.GET.and.resolveTo({
      data: { kyc_status: 'pending', kyc_submitted_at: null, kyc_rejection_reason: '', documents: [] },
    });
    await setup();
    fixture.detectChanges();
    await fixture.whenStable();

    apiClient.POST.and.resolveTo({
      data: { id: 'doc-1', document_type: 'other', file: '/media/x.pdf', status: 'pending', created_at: '2026-08-06T00:00:00Z' },
    });
    const file = new File(['content'], 'cert.pdf', { type: 'application/pdf' });
    fixture.componentInstance['onFileSelected'](file);
    apiClient.GET.calls.reset();

    await fixture.componentInstance['onUpload']();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/clients/me/kyc-documents/',
      jasmine.objectContaining({ body: jasmine.any(FormData) })
    );
    expect(apiClient.GET).toHaveBeenCalled();
    expect(fixture.componentInstance['selectedFile']()).toBeNull();
  });

  it('shows the server error message on upload failure', async () => {
    apiClient.GET.and.resolveTo({
      data: { kyc_status: 'pending', kyc_submitted_at: null, kyc_rejection_reason: '', documents: [] },
    });
    await setup();
    fixture.detectChanges();
    await fixture.whenStable();

    apiClient.POST.and.resolveTo({ error: { document_type: ['Invalid document type.'] } });
    fixture.componentInstance['onFileSelected'](new File(['x'], 'cert.pdf'));

    await fixture.componentInstance['onUpload']();

    expect(fixture.componentInstance['uploadError']()).toBe('Invalid document type.');
  });
});
