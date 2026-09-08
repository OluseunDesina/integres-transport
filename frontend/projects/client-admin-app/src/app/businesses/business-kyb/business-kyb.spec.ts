import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { BusinessKyb } from './business-kyb';
import { BusinessStore, type Business } from '../../shared/data/store/business.store';

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

function makeBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: 'biz-1',
    vertical: 'shuttle',
    name: 'Acme Shuttle',
    currency: 'NGN',
    timezone: 'Africa/Lagos',
    booking_mode_default: 'reservation',
    kyb_status: 'pending',
    kyb_submitted_at: null,
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  } as Business;
}

function makeDirector(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dir-1',
    business: 'biz-1',
    full_name: 'Ada Okafor',
    id_type: 'nin',
    id_number: '',
    is_active: true,
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    director: null,
    document_type: 'proof_of_address',
    file: '/media/kyb-documents/2026/08/bill.pdf',
    status: 'pending',
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeBusinessStore {
  items = signal<Business[]>([makeBusiness()]);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  /** Mirrors the real store's full-list lookup: match on the loaded
   * items, else null. The component must never fall back to reading
   * `items()` and `.find()`ing itself — doing so is what made any
   * business past the store's first page render "not found". */
  findById = jasmine
    .createSpy('findById')
    .and.callFake((id: string) =>
      Promise.resolve(this.items().find((b) => b.id === id) ?? null)
    );
}

describe('BusinessKyb', () => {
  let fixture: ComponentFixture<BusinessKyb>;
  let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy; PATCH: jasmine.Spy };
  let store: FakeBusinessStore;
  let authStore: AuthStore;

  /** Routes GET by path so directors and documents can be stubbed apart. */
  function stubReads(directors: unknown[], documents: unknown[]): void {
    apiClient.GET.and.callFake((path: string) =>
      Promise.resolve(
        path.includes('directors')
          ? { data: { count: directors.length, results: directors } }
          : { data: documents }
      )
    );
  }

  async function setup(permissions: string[]): Promise<void> {
    authStore = TestBed.inject(AuthStore);
    authStore.setSession('a', 'r', makeUser({ permissions }));
    fixture = TestBed.createComponent(BusinessKyb);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.clear();
    store = new FakeBusinessStore();
    apiClient = {
      GET: jasmine.createSpy('GET'),
      POST: jasmine.createSpy('POST'),
      PATCH: jasmine.createSpy('PATCH'),
    };
    stubReads([], []);

    TestBed.configureTestingModule({
      imports: [BusinessKyb],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: apiClient },
        { provide: BusinessStore, useValue: store },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => 'biz-1' } } },
        },
      ],
    });
  });

  afterEach(() => localStorage.clear());

  it('shows every required document section', async () => {
    await setup(['client-admin:access', 'client.view']);

    // Both halves are reachable from the tab list without a fetch, which
    // is why they are tabs rather than two routes.
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Directors');

    fixture.componentInstance['setActiveTab']('documents');
    fixture.detectChanges();
    const documentsText = fixture.nativeElement.textContent as string;
    expect(documentsText).toContain('Certificate of incorporation');
    expect(documentsText).toContain('Proof of address');
    expect(documentsText).toContain('Tax certificate');
    expect(documentsText).toContain('Other supporting documents');
  });

  it('tells the operator what counts as valid proof of address', async () => {
    await setup(['client-admin:access', 'client.view']);
    // Company documents live on their own tab now — the screen was the
    // longest in the console with both halves stacked.
    fixture.componentInstance['setActiveTab']('documents');
    fixture.detectChanges();

    // The whole point of the rebuild: an operator should learn what a
    // valid document looks like before uploading, not from a rejection.
    expect(fixture.nativeElement.textContent).toContain('dated within the last 3 months');
  });

  it('distinguishes supplied sections from outstanding ones', async () => {
    stubReads([], [makeDocument({ document_type: 'proof_of_address' })]);
    await setup(['client-admin:access', 'client.view']);
    // Company documents live on their own tab now — the screen was the
    // longest in the console with both halves stacked.
    fixture.componentInstance['setActiveTab']('documents');
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;

    // The old UI could not express this at all — it only ever offered
    // another blank upload.
    expect(text).toContain('bill.pdf');
    expect(text).toContain('Not supplied yet.');
  });

  it('lists directors and flags one with no ID uploaded', async () => {
    stubReads([makeDirector()], []);
    await setup(['client-admin:access', 'client.view']);
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Ada Okafor');
    expect(text).toContain('No ID uploaded yet.');
  });

  it('hides a soft-removed director without hiding their document', async () => {
    stubReads(
      [makeDirector(), makeDirector({ id: 'dir-2', full_name: 'Bola Adeyemi', is_active: false })],
      []
    );
    await setup(['client-admin:access', 'client.view']);

    expect(fixture.nativeElement.textContent).toContain('Ada Okafor');
    expect(fixture.nativeElement.textContent).not.toContain('Bola Adeyemi');
  });

  it('adds a director and reloads the list', async () => {
    await setup(['client-admin:access', 'client.view', 'business.manage']);
    apiClient.POST.and.resolveTo({ data: makeDirector() });

    fixture.componentInstance['directorForm'].setValue({
      full_name: 'Ada Okafor',
      id_type: 'nin',
      id_number: '12345678901',
    });
    await fixture.componentInstance['addDirector']();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/businesses/{business_id}/directors/',
      jasmine.objectContaining({ params: { path: { business_id: 'biz-1' } } })
    );
  });

  it('will not submit an empty director form, and says why', async () => {
    await setup(['client-admin:access', 'client.view', 'business.manage']);

    await fixture.componentInstance['addDirector']();
    fixture.detectChanges();

    expect(apiClient.POST).not.toHaveBeenCalled();
    // The rendered output, not just the call that didn't happen. The
    // original version of this test asserted only the latter, and the
    // screen shipped with no validation feedback at all: `ui-text-field`
    // renders an error only when the parent binds `[invalid]`/
    // `[errorMessage]`, which this template did not. Pressing "Add
    // director" on an empty form silently did nothing.
    expect(fixture.nativeElement.textContent).toContain('This field is required.');
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input[type="text"]');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('soft-removes a director rather than deleting them', async () => {
    stubReads([makeDirector()], []);
    await setup(['client-admin:access', 'client.view', 'business.manage']);
    apiClient.PATCH.and.resolveTo({ data: makeDirector({ is_active: false }) });

    await fixture.componentInstance['removeDirector'](makeDirector() as never);

    expect(apiClient.PATCH).toHaveBeenCalledWith(
      '/api/v1/directors/{id}/',
      jasmine.objectContaining({ body: { is_active: false } })
    );
  });

  it('sends the director id when uploading a director ID document', async () => {
    stubReads([makeDirector()], []);
    await setup(['client-admin:access', 'client.view', 'kyb.submit']);
    apiClient.POST.and.resolveTo({ data: makeDocument({ document_type: 'directors_id' }) });

    fixture.componentInstance['onFileSelected']('director:dir-1', {
      target: { files: [new File(['x'], 'id.pdf')] },
    } as unknown as Event);
    await fixture.componentInstance['upload']('director:dir-1', 'directors_id', 'dir-1');

    const body = apiClient.POST.calls.mostRecent().args[1].body as FormData;
    expect(body.get('document_type')).toBe('directors_id');
    expect(body.get('director')).toBe('dir-1');
  });

  it('refuses to upload with no file chosen', async () => {
    await setup(['client-admin:access', 'client.view', 'kyb.submit']);

    await fixture.componentInstance['upload']('tax_certificate', 'tax_certificate');

    expect(apiClient.POST).not.toHaveBeenCalled();
    expect(fixture.componentInstance['errorMessage']()).toBe('Choose a file to upload.');
  });

  it('hides write controls from a read-only viewer', async () => {
    stubReads([makeDirector()], []);
    await setup(['client-admin:access', 'client.view']);
    const text = fixture.nativeElement.textContent as string;

    // Still able to see how far verification has got, just not act on it.
    expect(text).toContain('Ada Okafor');
    expect(text).not.toContain('Add a director');
    expect(fixture.nativeElement.querySelector('input[type="file"]')).toBeNull();
  });
});
