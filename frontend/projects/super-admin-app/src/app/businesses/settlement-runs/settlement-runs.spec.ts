import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { expectColumnVisibilityParity } from '@shared-ui';

import { SettlementRuns } from './settlement-runs';
import {
  BusinessSuperAdminStore,
  type BusinessSuperAdmin,
} from '../../shared/data/store/business-super-admin.store';
import { SettlementRunStore, type SettlementRun } from '../../shared/data/store/settlement-run.store';

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
    booking_mode_default: 'reservation',
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<SettlementRun> = {}): SettlementRun {
  return {
    id: 'run-1',
    business: 'biz-1',
    period_start: '2026-08-01',
    period_end: '2026-08-08',
    status: 'paid_out',
    initiated_by: 'staff-1',
    total_amount: '475.00',
    currency: 'NGN',
    psp_transfer_reference: 'TRF_abc123',
    psp_transfer_status: 'success',
    executed_at: '2026-08-08T00:00:00Z',
    created_at: '2026-08-08T00:00:00Z',
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

class FakeSettlementRunStore {
  items = signal<SettlementRun[]>([]);
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  updateQuery = jasmine.createSpy('updateQuery').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

describe('SettlementRuns', () => {
  let fixture: ComponentFixture<SettlementRuns>;
  let store: FakeSettlementRunStore;
  let apiClient: { POST: jasmine.Spy };

  beforeEach(async () => {
    localStorage.clear();
    store = new FakeSettlementRunStore();
    apiClient = { POST: jasmine.createSpy('POST') };

    await TestBed.configureTestingModule({
      imports: [SettlementRuns],
      providers: [
        provideRouter([]),
        { provide: BusinessSuperAdminStore, useValue: new FakeBusinessSuperAdminStore() },
        { provide: SettlementRunStore, useValue: store },
        { provide: API_CLIENT, useValue: apiClient },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'biz-1' }) } },
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

    fixture = TestBed.createComponent(SettlementRuns);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('scopes the store to the route business id on init', () => {
    expect(store.updateQuery).toHaveBeenCalledWith({ business: 'biz-1' });
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No settlement runs yet');
  });

  it('renders a row per run with status, total, and reference', () => {
    store.items.set([makeRun()]);
    fixture.detectChanges();

    const row = fixture.debugElement.query(By.css('tbody tr'));
    expect(row.nativeElement.textContent).toContain('Paid out');
    expect(row.nativeElement.textContent).toContain('NGN 475.00');
    expect(row.nativeElement.textContent).toContain('TRF_abc123');
  });

  it('does not submit the trigger form when a date is missing', async () => {
    await fixture.componentInstance['onTrigger']();

    expect(apiClient.POST).not.toHaveBeenCalled();
  });

  it('triggers a settlement run and refreshes the list on success', async () => {
    apiClient.POST.and.resolveTo({ data: makeRun({ id: 'run-2', status: 'processing' }) });
    fixture.componentInstance['form'].setValue({
      period_start: '2026-08-01',
      period_end: '2026-08-08',
    });

    await fixture.componentInstance['onTrigger']();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/settlement-runs/',
      jasmine.objectContaining({
        body: { business: 'biz-1', period_start: '2026-08-01', period_end: '2026-08-08' },
      })
    );
    expect(store.getAll).toHaveBeenCalled();
  });

  it('shows a link to the Paystack config screen on a 404 (no payout destination)', async () => {
    apiClient.POST.and.resolveTo({
      data: undefined,
      error: { detail: 'This Business has no configured Paystack payout destination.' },
      response: { status: 404 },
    });
    fixture.componentInstance['form'].setValue({
      period_start: '2026-08-01',
      period_end: '2026-08-08',
    });

    await fixture.componentInstance['onTrigger']();
    fixture.detectChanges();

    expect(fixture.componentInstance['payoutNotConfigured']()).toBeTrue();
    const link = fixture.debugElement.query(By.css('ui-alert a'));
    expect(link.nativeElement.getAttribute('href')).toBe('/businesses/biz-1/paystack-account');
  });

  it('shows the conflict message for a duplicate period (409)', async () => {
    apiClient.POST.and.resolveTo({
      data: undefined,
      error: { detail: 'A settlement run for this business and period already exists.' },
      response: { status: 409 },
    });
    fixture.componentInstance['form'].setValue({
      period_start: '2026-08-01',
      period_end: '2026-08-08',
    });

    await fixture.componentInstance['onTrigger']();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'A settlement run for this business and period already exists.'
    );
  });
  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makeRun()]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'settlement-runs');
  });

});
