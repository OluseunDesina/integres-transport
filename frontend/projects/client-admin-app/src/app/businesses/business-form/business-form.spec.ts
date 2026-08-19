import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { BusinessForm } from './business-form';
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
    name: 'Acme Shuttle Co',
    currency: 'NGN',
    timezone: 'Africa/Lagos',
    booking_mode_default: 'reservation',
    kyb_status: 'pending',
    kyb_submitted_at: null,
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeBusinessStore {
  items = signal<Business[]>([]);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
}

async function setup(paramId: string | null, existing: Business[] = []) {
  const apiClient = { GET: jasmine.createSpy('GET'), POST: jasmine.createSpy('POST'), PATCH: jasmine.createSpy('PATCH') };
  const store = new FakeBusinessStore();
  store.items.set(existing);

  await TestBed.configureTestingModule({
    imports: [BusinessForm],
    providers: [
      provideRouter([]),
      { provide: API_CLIENT, useValue: apiClient },
      { provide: BusinessStore, useValue: store },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap(paramId ? { id: paramId } : {}) } },
      },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(BusinessForm);
  return { fixture, apiClient, store };
}

describe('BusinessForm', () => {
  describe('create mode', () => {
    let fixture: ComponentFixture<BusinessForm>;
    let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy; PATCH: jasmine.Spy };

    beforeEach(async () => {
      ({ fixture, apiClient } = await setup(null));
      fixture.detectChanges();
      await fixture.whenStable();
    });

    it('renders the "New business" heading', () => {
      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('New business');
    });

    it('does not submit an invalid (empty name) form', async () => {
      await fixture.componentInstance['onSubmit']();
      expect(apiClient.POST).not.toHaveBeenCalled();
    });

    it('creates a business and navigates to /businesses on success', async () => {
      apiClient.POST.and.resolveTo({ data: makeBusiness() });
      const router = TestBed.inject(Router);
      const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

      fixture.componentInstance['form'].setValue({
        vertical: 'shuttle',
        name: 'Acme Shuttle Co',
        currency: 'NGN',
        timezone: 'Africa/Lagos',
        booking_mode_default: 'reservation',
      });

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/businesses/',
        jasmine.objectContaining({
          body: jasmine.objectContaining({ name: 'Acme Shuttle Co', vertical: 'shuttle' }),
        })
      );
      expect(navigateSpy).toHaveBeenCalledWith(['/businesses']);
    });

    it('shows the server error message on failure', async () => {
      apiClient.POST.and.resolveTo({ error: { name: ['A business with this name already exists.'] } });
      fixture.componentInstance['form'].setValue({
        vertical: 'shuttle',
        name: 'Acme Shuttle Co',
        currency: 'NGN',
        timezone: 'Africa/Lagos',
        booking_mode_default: 'reservation',
      });

      await fixture.componentInstance['onSubmit']();
      fixture.detectChanges();

      expect(fixture.componentInstance['errorMessage']()).toBe(
        'A business with this name already exists.'
      );
    });
  });

  describe('edit mode', () => {
    it('prefills the form and shows the KYB status pill when the business is found', async () => {
      const business = makeBusiness({ kyb_status: 'approved' });
      const { fixture } = await setup('biz-1', [business]);

      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Edit business');
      expect(fixture.componentInstance['form'].value.name).toBe('Acme Shuttle Co');
      const pill = fixture.debugElement.query(By.css('ui-status-pill'));
      expect(pill).not.toBeNull();
    });

    it('patches the business at its id on submit', async () => {
      const business = makeBusiness();
      const { fixture, apiClient } = await setup('biz-1', [business]);
      fixture.detectChanges();
      await fixture.whenStable();
      apiClient.PATCH.and.resolveTo({ data: business });
      const router = TestBed.inject(Router);
      spyOn(router, 'navigate').and.resolveTo(true);

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.PATCH).toHaveBeenCalledWith(
        '/api/v1/businesses/{id}/',
        jasmine.objectContaining({ params: { path: { id: 'biz-1' } } })
      );
    });

    it('shows a not-found message when the business is not in the store', async () => {
      const { fixture, store } = await setup('missing-id', []);
      store.getAll.and.callFake(() => {
        store.items.set([]);
        return Promise.resolve();
      });

      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain("couldn't be found");
    });

    describe('KYB document upload', () => {
      async function setupEditing() {
        const business = makeBusiness();
        const result = await setup('biz-1', [business]);
        const authStore = TestBed.inject(AuthStore);
        return { ...result, business, authStore };
      }

      it('hides the upload section without kyb.submit permission', async () => {
        const { fixture, authStore } = await setupEditing();
        authStore.setSession('a', 'r', makeUser({ permissions: ['client-admin:access'] }));
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).not.toContain('Upload a KYB document');
      });

      it('uploads a document and refreshes the business on success', async () => {
        const { fixture, apiClient, store, authStore } = await setupEditing();
        authStore.setSession(
          'a',
          'r',
          makeUser({ permissions: ['client-admin:access', 'kyb.submit'] })
        );
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        apiClient.POST.and.resolveTo({
          data: {
            id: 'doc-1',
            document_type: 'other',
            file: '/media/x.pdf',
            status: 'pending',
            created_at: '2026-08-06T00:00:00Z',
          },
        });
        store.items.set([makeBusiness({ kyb_status: 'submitted' })]);
        fixture.componentInstance['onKybFileSelected'](new File(['x'], 'cert.pdf'));

        await fixture.componentInstance['onKybUpload']();

        expect(apiClient.POST).toHaveBeenCalledWith(
          '/api/v1/businesses/{business_id}/kyb-documents/',
          jasmine.objectContaining({
            params: { path: { business_id: 'biz-1' } },
            body: jasmine.any(FormData),
          })
        );
        expect(fixture.componentInstance['existingBusiness']()?.kyb_status).toBe('submitted');
        expect(fixture.componentInstance['kybSelectedFile']()).toBeNull();
      });

      it('shows a required-file error before submitting', async () => {
        const { fixture, apiClient, authStore } = await setupEditing();
        authStore.setSession(
          'a',
          'r',
          makeUser({ permissions: ['client-admin:access', 'kyb.submit'] })
        );
        fixture.detectChanges();
        await fixture.whenStable();

        await fixture.componentInstance['onKybUpload']();

        expect(apiClient.POST).not.toHaveBeenCalled();
        expect(fixture.componentInstance['kybUploadError']()).toBe('Choose a file to upload.');
      });
    });
  });
});
