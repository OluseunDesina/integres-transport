import { Dialog } from '@angular/cdk/dialog';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { ConfirmDialogData } from '@shared-ui';
import { Subject } from 'rxjs';

import { KycQueue } from './kyc-queue';
import { KycQueueStore, type ClientKycQueueItem } from '../shared/data/store/kyc-queue.store';

function makeClient(overrides: Partial<ClientKycQueueItem> = {}): ClientKycQueueItem {
  return {
    id: 'client-1',
    name: 'Acme Shuttle Co',
    email: 'owner@example.com',
    phone: '',
    kyc_status: 'submitted',
    kyc_submitted_at: '2026-08-06T00:00:00Z',
    documents: [],
    ...overrides,
  };
}

class FakeKycQueueStore {
  items = signal<ClientKycQueueItem[]>([]);
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

describe('KycQueue', () => {
  let fixture: ComponentFixture<KycQueue>;
  let store: FakeKycQueueStore;
  let dialogSpy: jasmine.SpyObj<Dialog>;
  let apiClient: { POST: jasmine.Spy };
  let closedSubject: Subject<boolean | undefined>;

  beforeEach(async () => {
    store = new FakeKycQueueStore();
    apiClient = { POST: jasmine.createSpy('POST') };
    closedSubject = new Subject<boolean | undefined>();
    dialogSpy = jasmine.createSpyObj<Dialog>('Dialog', ['open']);
    dialogSpy.open.and.returnValue({ closed: closedSubject.asObservable() } as ReturnType<
      Dialog['open']
    >);

    await TestBed.configureTestingModule({
      imports: [KycQueue],
      providers: [
        { provide: KycQueueStore, useValue: store },
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

    fixture = TestBed.createComponent(KycQueue);
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

  it('renders a row per queued client', () => {
    store.items.set([makeClient()]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(1);
    expect(rows[0].nativeElement.textContent).toContain('Acme Shuttle Co');
  });

  it('opens the confirm dialog with the client name in the title on Review', () => {
    store.items.set([makeClient()]);
    fixture.detectChanges();

    fixture.debugElement.query(By.css('button')).nativeElement.click();

    expect(dialogSpy.open).toHaveBeenCalled();
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toBe('Review Acme Shuttle Co');
    expect(data.confirmDisabled()).toBeFalse();
  });

  it('disables confirm until a reason is set once reject is chosen', () => {
    store.items.set([makeClient()]);
    fixture.detectChanges();
    fixture.debugElement.query(By.css('button')).nativeElement.click();
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;

    fixture.componentInstance['setDecision']('reject');
    expect(data.confirmDisabled()).toBeTrue();

    fixture.componentInstance['setReason']('Missing documents.');
    expect(data.confirmDisabled()).toBeFalse();
  });

  it('refetches the list once the dialog closes', async () => {
    store.items.set([makeClient()]);
    fixture.detectChanges();
    fixture.debugElement.query(By.css('button')).nativeElement.click();
    store.getAll.calls.reset();

    closedSubject.next(true);
    // The refetch is deferred a tick past dialog close so it doesn't
    // race CDK's own focus-restoration sequence — see kyc-queue.ts.
    await new Promise((resolve) => setTimeout(resolve));

    expect(store.getAll).toHaveBeenCalled();
  });

  it('POSTs the decision via onConfirm and reports success', async () => {
    apiClient.POST.and.resolveTo({ data: makeClient({ kyc_status: 'approved' }) });
    store.items.set([makeClient()]);
    fixture.detectChanges();
    fixture.debugElement.query(By.css('button')).nativeElement.click();
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;

    const result = await data.onConfirm();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/super-admin/kyc-queue/{client_id}/decide/',
      jasmine.objectContaining({
        params: { path: { client_id: 'client-1' } },
        body: { decision: 'approve', reason: undefined },
      })
    );
    expect(result).toEqual({ ok: true });
  });

  it('surfaces the server error via onConfirm on failure', async () => {
    apiClient.POST.and.resolveTo({
      error: { reason: ['A reason is required when rejecting.'] },
    });
    store.items.set([makeClient()]);
    fixture.detectChanges();
    fixture.debugElement.query(By.css('button')).nativeElement.click();
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;

    const result = await data.onConfirm();

    expect(result).toEqual({ ok: false, error: 'A reason is required when rejecting.' });
  });
});
