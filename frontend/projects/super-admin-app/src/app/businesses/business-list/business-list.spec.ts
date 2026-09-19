import { Dialog } from '@angular/cdk/dialog';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { expectColumnVisibilityParity } from '@shared-ui';
import type { ConfirmDialogData } from '@shared-ui';
import { Subject } from 'rxjs';

import { BusinessList } from './business-list';
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
    booking_mode_default: 'reservation',
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeBusinessSuperAdminStore {
  items = signal<BusinessSuperAdmin[]>([]);
  total = signal(0);
  query = signal<{ search?: string }>({});
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  updateQuery = jasmine.createSpy('updateQuery').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

/** What `applyFilters()` always sends — every key present, unset ones
 * `undefined` — since jasmine's `toHaveBeenCalledWith` treats a missing
 * key and an `undefined`-valued one as different objects. */
function expectedQuery(overrides: {
  search?: string;
  kyb_status?: string;
  vertical?: string;
  is_active?: string;
}): unknown {
  return {
    search: undefined,
    kyb_status: undefined,
    vertical: undefined,
    is_active: undefined,
    ...overrides,
  };
}

describe('BusinessList', () => {
  let fixture: ComponentFixture<BusinessList>;
  let store: FakeBusinessSuperAdminStore;
  let router: Router;
  let dialogSpy: jasmine.SpyObj<Dialog>;
  let apiClient: { POST: jasmine.Spy };
  let closedSubject: Subject<boolean | undefined>;

  beforeEach(async () => {
    store = new FakeBusinessSuperAdminStore();
    apiClient = { POST: jasmine.createSpy('POST') };
    closedSubject = new Subject<boolean | undefined>();
    dialogSpy = jasmine.createSpyObj<Dialog>('Dialog', ['open']);
    dialogSpy.open.and.returnValue({ closed: closedSubject.asObservable() } as ReturnType<
      Dialog['open']
    >);

    await TestBed.configureTestingModule({
      imports: [BusinessList],
      providers: [
        provideRouter([]),
        { provide: BusinessSuperAdminStore, useValue: store },
        { provide: Dialog, useValue: dialogSpy },
        { provide: API_CLIENT, useValue: apiClient },
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

    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(BusinessList);
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('calls getAll() on init', () => {
    expect(store.getAll).toHaveBeenCalled();
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No businesses found');
  });

  it('renders a row per business with client, vertical, and status', () => {
    store.items.set([makeBusiness(), makeBusiness({ id: 'biz-2', is_active: false })]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0].nativeElement.textContent).toContain('Acme Shuttle Lagos');
    expect(rows[0].nativeElement.textContent).toContain('Acme Shuttle Co');
    expect(rows[0].nativeElement.textContent).toContain('Active');
    expect(rows[1].nativeElement.textContent).toContain('Inactive');
  });

  it('shows the server error message instead of the table', () => {
    store.error.set('Failed to load businesses.');
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('table'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Failed to load businesses.');
  });

  // --- Search, through ui-filter-bar ---

  function typeSearch(value: string): void {
    const input = fixture.debugElement.query(By.css('input[type="search"]'))
      .nativeElement as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('queries the store with the trimmed search term once the debounce elapses', fakeAsync(() => {
    typeSearch('  Lagos  ');
    tick(300);

    expect(store.updateQuery).toHaveBeenCalledWith(expectedQuery({ search: 'Lagos' }));
  }));

  it('does not query the store on every keystroke', fakeAsync(() => {
    store.updateQuery.calls.reset();
    typeSearch('L');
    typeSearch('La');
    typeSearch('Lag');
    expect(store.updateQuery).not.toHaveBeenCalled();

    tick(300);
    expect(store.updateQuery).toHaveBeenCalledTimes(1);
  }));

  it('sends an undefined search when the field holds only whitespace', fakeAsync(() => {
    typeSearch('   ');
    tick(300);

    expect(store.updateQuery).toHaveBeenCalledWith(expectedQuery({}));
  }));

  it('calls store.changePage() when the paginator emits', () => {
    store.items.set([makeBusiness()]);
    store.total.set(30);
    fixture.detectChanges();

    const buttons = fixture.debugElement.queryAll(By.css('button'));
    const nextButton = buttons.find((b) =>
      (b.nativeElement.textContent as string).includes('Next')
    );
    nextButton?.nativeElement.click();

    expect(store.changePage).toHaveBeenCalledWith(25);
  });

  // --- KYB status / vertical / active filters, gained once the
  // separate KYB queue page was folded into this list. ---

  it('queries the store with the chosen KYB status filter', () => {
    fixture.componentInstance['onKybStatusFilterChange']('submitted');

    expect(store.updateQuery).toHaveBeenCalledWith(expectedQuery({ kyb_status: 'submitted' }));
  });

  it('queries the store with the chosen vertical filter', () => {
    fixture.componentInstance['onVerticalFilterChange']('metro');

    expect(store.updateQuery).toHaveBeenCalledWith(expectedQuery({ vertical: 'metro' }));
  });

  it('queries the store with the chosen active-status filter', () => {
    fixture.componentInstance['onActiveFilterChange']('false');

    expect(store.updateQuery).toHaveBeenCalledWith(expectedQuery({ is_active: 'false' }));
  });

  it('renders a chip per active filter and clears it on removal', () => {
    fixture.componentInstance['onKybStatusFilterChange']('submitted');
    fixture.detectChanges();

    const chip = fixture.debugElement
      .queryAll(By.css('button'))
      .find((el) =>
        (el.nativeElement as HTMLElement).getAttribute('aria-label')?.startsWith('Remove filter')
      );
    expect(chip).toBeDefined();
    expect((chip!.nativeElement as HTMLElement).textContent).toContain('KYB status: Submitted');

    (chip!.nativeElement as HTMLButtonElement).click();
    expect(store.updateQuery).toHaveBeenCalledWith(expectedQuery({}));
  });

  it("clears every filter from the filter bar's clear-all", () => {
    fixture.componentInstance['onKybStatusFilterChange']('submitted');
    fixture.componentInstance['onVerticalFilterChange']('metro');
    fixture.detectChanges();

    fixture.componentInstance['onFiltersCleared']();

    expect(store.updateQuery).toHaveBeenCalledWith(expectedQuery({}));
  });

  it('shows a filters-aware empty state rather than the generic one', () => {
    fixture.componentInstance['onKybStatusFilterChange']('submitted');
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No business matches these filters');
  });

  // --- Row actions: a three-dot ui-action-menu, replacing the three
  // plain links this list used to render side by side (same convention
  // as client-admin-app's own business list). ---

  it('offers Paystack, Settlements, and Seat hold on every row, and navigates on selection', () => {
    const items = fixture.componentInstance['menuItems'](makeBusiness());
    expect(items.map((item) => item.id)).toEqual([
      'paystack-account',
      'settlement-runs',
      'seat-hold',
    ]);

    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance['onMenuSelected'](makeBusiness(), 'paystack-account');

    expect(navigateSpy).toHaveBeenCalledWith(['/businesses', 'biz-1', 'paystack-account']);
  });

  it('offers Review KYB only while the business is awaiting review, and hides it otherwise', () => {
    const submitted = fixture.componentInstance['menuItems'](makeBusiness({ kyb_status: 'submitted' }));
    const approved = fixture.componentInstance['menuItems'](makeBusiness({ kyb_status: 'approved' }));

    expect(submitted.map((item) => item.id)).toContain('review-kyb');
    expect(approved.map((item) => item.id)).not.toContain('review-kyb');
  });

  // --- KYB decide dialog, moved here from the formerly separate
  // kyb-queue page. ---

  it('opens the confirm dialog with the business name in the title on Review', () => {
    fixture.componentInstance['onMenuSelected'](
      makeBusiness({ kyb_status: 'submitted' }),
      'review-kyb'
    );

    expect(dialogSpy.open).toHaveBeenCalled();
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toBe('Review Acme Shuttle Lagos');
    expect(data.confirmDisabled()).toBeFalse();
  });

  it('disables confirm until a reason is set once reject is chosen', () => {
    fixture.componentInstance['onMenuSelected'](
      makeBusiness({ kyb_status: 'submitted' }),
      'review-kyb'
    );
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;

    fixture.componentInstance['setDecision']('reject');
    expect(data.confirmDisabled()).toBeTrue();

    fixture.componentInstance['setReason']('Missing documents.');
    expect(data.confirmDisabled()).toBeFalse();
  });

  it('refetches the list once the dialog closes on an actual decision', async () => {
    fixture.componentInstance['onMenuSelected'](
      makeBusiness({ kyb_status: 'submitted' }),
      'review-kyb'
    );
    store.getAll.calls.reset();

    closedSubject.next(true);
    // Deferred a tick past dialog close so it doesn't race CDK's own
    // focus-restoration sequence — see business-list.ts's own note.
    await new Promise((resolve) => setTimeout(resolve));

    expect(store.getAll).toHaveBeenCalled();
  });

  it('does not refetch on cancel', async () => {
    fixture.componentInstance['onMenuSelected'](
      makeBusiness({ kyb_status: 'submitted' }),
      'review-kyb'
    );
    store.getAll.calls.reset();

    closedSubject.next(false);
    await new Promise((resolve) => setTimeout(resolve));

    expect(store.getAll).not.toHaveBeenCalled();
  });

  it('POSTs the decision via onConfirm and reports success', async () => {
    apiClient.POST.and.resolveTo({ data: makeBusiness({ kyb_status: 'approved' }) });
    fixture.componentInstance['onMenuSelected'](
      makeBusiness({ kyb_status: 'submitted' }),
      'review-kyb'
    );
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;

    const result = await data.onConfirm();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/super-admin/kyb-queue/{business_id}/decide/',
      jasmine.objectContaining({
        params: { path: { business_id: 'biz-1' } },
        body: { decision: 'approve', reason: undefined },
      })
    );
    expect(result).toEqual({ ok: true });
  });

  it('surfaces the server error via onConfirm on failure', async () => {
    apiClient.POST.and.resolveTo({
      error: { reason: ['A reason is required when rejecting.'] },
    });
    fixture.componentInstance['onMenuSelected'](
      makeBusiness({ kyb_status: 'submitted' }),
      'review-kyb'
    );
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;

    const result = await data.onConfirm();

    expect(result).toEqual({ ok: false, error: 'A reason is required when rejecting.' });
  });

  it('resets the reason and its touched state between reviews', () => {
    fixture.componentInstance['onMenuSelected'](
      makeBusiness({ kyb_status: 'submitted' }),
      'review-kyb'
    );
    fixture.componentInstance['setDecision']('reject');
    fixture.componentInstance['setReason']('');
    expect(fixture.componentInstance['reasonError']()).not.toBeNull();

    fixture.componentInstance['onMenuSelected'](
      makeBusiness({ kyb_status: 'submitted' }),
      'review-kyb'
    );

    expect(fixture.componentInstance['reasonError']()).toBeNull();
    expect(fixture.componentInstance['decision']()).toBe('approve');
  });

  it('offers both decisions as one real radio group', () => {
    expect(fixture.componentInstance['decisionOptions'].map((o) => o.value)).toEqual([
      'approve',
      'reject',
    ]);
  });

  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makeBusiness()]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'business-list');
  });
});
