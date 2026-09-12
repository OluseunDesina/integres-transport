import { Dialog } from '@angular/cdk/dialog';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { expectColumnVisibilityParity } from '@shared-ui';
import type { ConfirmDialogData } from '@shared-ui';
import { Subject } from 'rxjs';

import { KybQueue } from './kyb-queue';
import { KybQueueStore, type BusinessKybQueueItem } from '../shared/data/store/kyb-queue.store';

function makeBusiness(overrides: Partial<BusinessKybQueueItem> = {}): BusinessKybQueueItem {
  return {
    id: 'biz-1',
    client: 'client-1',
    client_name: 'Acme Shuttle Co',
    vertical: 'shuttle',
    name: 'Acme Shuttle Lagos',
    kyb_status: 'submitted',
    kyb_submitted_at: '2026-08-06T00:00:00Z',
    documents: [],
    directors: [],
    ...overrides,
  };
}

class FakeKybQueueStore {
  items = signal<BusinessKybQueueItem[]>([]);
  total = signal(0);
  query = signal<{ search?: string }>({});
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
  updateQuery = jasmine.createSpy('updateQuery').and.resolveTo();
}

describe('KybQueue', () => {
  let fixture: ComponentFixture<KybQueue>;
  let store: FakeKybQueueStore;
  let dialogSpy: jasmine.SpyObj<Dialog>;
  let apiClient: { POST: jasmine.Spy };
  let closedSubject: Subject<boolean | undefined>;

  beforeEach(async () => {
    store = new FakeKybQueueStore();
    apiClient = { POST: jasmine.createSpy('POST') };
    closedSubject = new Subject<boolean | undefined>();
    dialogSpy = jasmine.createSpyObj<Dialog>('Dialog', ['open']);
    dialogSpy.open.and.returnValue({ closed: closedSubject.asObservable() } as ReturnType<
      Dialog['open']
    >);

    await TestBed.configureTestingModule({
      imports: [KybQueue],
      providers: [
        { provide: KybQueueStore, useValue: store },
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

    fixture = TestBed.createComponent(KybQueue);
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('calls getAll() on init', () => {
    expect(store.getAll).toHaveBeenCalled();
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No submissions to review');
  });

  it('shows a search-aware empty state when a search matches nothing', () => {
    store.isEmpty.set(true);
    store.query.set({ search: 'nowhere' });
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No matching submissions');
    expect(fixture.nativeElement.textContent).toContain('nowhere');
  });

  it('forwards the filter bar search input to the store', () => {
    fixture.componentInstance['onSearchChange']('lagos');

    expect(store.updateQuery).toHaveBeenCalledWith({ search: 'lagos' });
  });

  it('renders a row per queued business', () => {
    store.items.set([makeBusiness()]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(1);
    expect(rows[0].nativeElement.textContent).toContain('Acme Shuttle Lagos');
    expect(rows[0].nativeElement.textContent).toContain('Acme Shuttle Co');
  });

  it('opens the confirm dialog with the business name in the title on Review', () => {
    store.items.set([makeBusiness()]);
    fixture.detectChanges();

    fixture.debugElement.query(By.css('button')).nativeElement.click();

    expect(dialogSpy.open).toHaveBeenCalled();
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toBe('Review Acme Shuttle Lagos');
    expect(data.confirmDisabled()).toBeFalse();
  });

  it('disables confirm until a reason is set once reject is chosen', () => {
    store.items.set([makeBusiness()]);
    fixture.detectChanges();
    fixture.debugElement.query(By.css('button')).nativeElement.click();
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;

    fixture.componentInstance['setDecision']('reject');
    expect(data.confirmDisabled()).toBeTrue();

    fixture.componentInstance['setReason']('Missing documents.');
    expect(data.confirmDisabled()).toBeFalse();
  });

  it('refetches the list once the dialog closes', async () => {
    store.items.set([makeBusiness()]);
    fixture.detectChanges();
    fixture.debugElement.query(By.css('button')).nativeElement.click();
    store.getAll.calls.reset();

    closedSubject.next(true);
    // The refetch is deferred a tick past dialog close so it doesn't
    // race CDK's own focus-restoration sequence — see kyb-queue.ts.
    await new Promise((resolve) => setTimeout(resolve));

    expect(store.getAll).toHaveBeenCalled();
  });

  it('POSTs the decision via onConfirm and reports success', async () => {
    apiClient.POST.and.resolveTo({ data: makeBusiness({ kyb_status: 'approved' }) });
    store.items.set([makeBusiness()]);
    fixture.detectChanges();
    fixture.debugElement.query(By.css('button')).nativeElement.click();
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
    store.items.set([makeBusiness()]);
    fixture.detectChanges();
    fixture.debugElement.query(By.css('button')).nativeElement.click();
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;

    const result = await data.onConfirm();

    expect(result).toEqual({ ok: false, error: 'A reason is required when rejecting.' });
  });
  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makeBusiness()]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'kyb-queue');
  });


  /**
   * The reason box was a hand-rolled `<textarea>` with
   * `border border-slate-300` — the input border slice 1 measured at
   * 1.48:1 and replaced everywhere else — no label association beyond a
   * hand-written `for`, and no way to render an error. It is
   * `ui-textarea` now, and the requirement is *shown* rather than only
   * enforced by a disabled button.
   */
  it('says why confirm is disabled once the reviewer has engaged with the reason', () => {
    expect(fixture.componentInstance['reasonError']()).toBeNull();

    fixture.componentInstance['setDecision']('reject');
    // Untouched: the disabled button is the signal, not a red field.
    expect(fixture.componentInstance['reasonError']()).toBeNull();

    fixture.componentInstance['setReason']('Missing documents.');
    fixture.componentInstance['setReason']('');

    expect(fixture.componentInstance['reasonError']()).toContain('Give a reason');
  });

  it('resets the reason and its touched state between reviews', () => {
    store.items.set([makeBusiness()]);
    fixture.detectChanges();
    fixture.componentInstance['setDecision']('reject');
    fixture.componentInstance['setReason']('');
    expect(fixture.componentInstance['reasonError']()).not.toBeNull();

    fixture.debugElement.query(By.css('button')).nativeElement.click();

    expect(fixture.componentInstance['reasonError']()).toBeNull();
    expect(fixture.componentInstance['decision']()).toBe('approve');
  });

  it('offers both decisions as one real radio group', () => {
    store.items.set([makeBusiness()]);
    fixture.detectChanges();

    expect(fixture.componentInstance['decisionOptions'].map((o) => o.value)).toEqual([
      'approve',
      'reject',
    ]);
  });
});
