import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';

import { PaystackConfig } from './paystack-config';
import {
  BusinessSuperAdminStore,
  type BusinessSuperAdmin,
} from '../../shared/data/store/business-super-admin.store';

function makeBusiness(overrides: Partial<BusinessSuperAdmin> = {}): BusinessSuperAdmin {
  return {
    id: 'biz-1',
    client: 'client-1',
    client_name: 'Acme Shuttle Co',
    name: 'Acme Shuttle Lagos',
    vertical: 'shuttle',
    currency: 'NGN',
    is_active: true,
    kyb_status: 'approved',
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeBusinessSuperAdminStore {
  items = signal<BusinessSuperAdmin[]>([makeBusiness()]);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  updateQuery = jasmine.createSpy('updateQuery').and.resolveTo();
  findById = jasmine.createSpy('findById').and.callFake((id: string) =>
    Promise.resolve(this.items().find((b) => b.id === id) ?? null)
  );
}

describe('PaystackConfig', () => {
  let fixture: ComponentFixture<PaystackConfig>;
  let apiClient: { GET: jasmine.Spy; PATCH: jasmine.Spy };

  async function createComponent(routeId = 'biz-1'): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [PaystackConfig],
      providers: [
        { provide: BusinessSuperAdminStore, useValue: new FakeBusinessSuperAdminStore() },
        { provide: API_CLIENT, useValue: apiClient },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: routeId }) } },
        },
      ],
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

    fixture = TestBed.createComponent(PaystackConfig);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.clear();
    apiClient = { GET: jasmine.createSpy('GET'), PATCH: jasmine.createSpy('PATCH') };
  });

  afterEach(() => localStorage.clear());

  it('renders a blank form and no error when nothing is configured yet (404)', async () => {
    apiClient.GET.and.resolveTo({
      data: undefined,
      error: { detail: 'No Paystack account configured for this business yet.' },
      response: { status: 404 },
    });

    await createComponent();

    expect(fixture.nativeElement.textContent).toContain('Not yet configured');
    expect(fixture.nativeElement.textContent).not.toContain(
      'Could not load the current Paystack configuration.'
    );
  });

  it('prefills the form when a configuration already exists', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        id: 'acct-1',
        bank_code: '058',
        account_number: '0123456789',
        account_name: 'Acme Shuttle Lagos',
        recipient_code: 'RCP_existing',
        is_active: true,
        verified_at: null,
      },
    });

    await createComponent();

    expect(fixture.componentInstance['form'].controls.recipient_code.value).toBe('RCP_existing');
    expect(fixture.componentInstance['alreadyConfigured']()).toBeTrue();
  });

  it('surfaces the real server message for a non-404 GET failure', async () => {
    apiClient.GET.and.resolveTo({
      data: undefined,
      error: { detail: 'Something went wrong.' },
      response: { status: 500 },
    });

    await createComponent();

    expect(fixture.nativeElement.textContent).toContain('Something went wrong.');
  });

  it('falls back to a generic message when the error has no recognizable shape', async () => {
    apiClient.GET.and.resolveTo({
      data: undefined,
      error: {},
      response: { status: 500 },
    });

    await createComponent();

    expect(fixture.nativeElement.textContent).toContain(
      'Could not load the current Paystack configuration.'
    );
  });

  it('shows "Business not found" for an unknown route id', async () => {
    await createComponent('unknown-id');

    expect(fixture.nativeElement.textContent).toContain('Business not found.');
    expect(apiClient.GET).not.toHaveBeenCalled();
  });

  it('does not submit without a recipient_code', async () => {
    apiClient.GET.and.resolveTo({
      data: undefined,
      error: { detail: 'Not configured yet.' },
      response: { status: 404 },
    });
    await createComponent();

    await fixture.componentInstance['onSubmit']();

    expect(apiClient.PATCH).not.toHaveBeenCalled();
  });

  it('PATCHes the form and shows a success message', async () => {
    apiClient.GET.and.resolveTo({
      data: undefined,
      error: { detail: 'Not configured yet.' },
      response: { status: 404 },
    });
    await createComponent();
    fixture.componentInstance['form'].controls.recipient_code.setValue('RCP_new');
    apiClient.PATCH.and.resolveTo({
      data: {
        id: 'acct-1',
        bank_code: '',
        account_number: '',
        account_name: '',
        recipient_code: 'RCP_new',
        is_active: true,
        verified_at: null,
      },
    });

    await fixture.componentInstance['onSubmit']();
    fixture.detectChanges();

    expect(apiClient.PATCH).toHaveBeenCalledWith(
      '/api/v1/super-admin/businesses/{id}/paystack-account/',
      jasmine.objectContaining({ params: { path: { id: 'biz-1' } } })
    );
    expect(fixture.nativeElement.textContent).toContain('Paystack account saved.');
  });
});
