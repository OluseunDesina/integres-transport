import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { API_CLIENT } from '@api-client';

import { LedgerOverview } from './ledger-overview';
import { LedgerEntryStore, type JournalEntry } from '../../shared/data/store/ledger-entry.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acct-clearing',
    account_type: 'business_clearing',
    business: 'biz-1',
    passenger: null,
    psp_provider: '',
    cached_balance: '2500.00',
    cached_balance_updated_at: '2026-08-15T00:00:00Z',
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function makeJournalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'entry-1',
    business: 'biz-1',
    entry_type: 'payment',
    external_reference: 'ref-1',
    memo: 'Trip fare',
    settlement_run: null,
    lines: [
      { id: 'line-1', account: 'acct-clearing', amount: '1500.00', currency: 'NGN' },
      { id: 'line-2', account: 'acct-commission', amount: '-1500.00', currency: 'NGN' },
    ],
    created_at: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

class FakeLedgerEntryStore {
  items = signal<JournalEntry[]>([]);
  total = signal(0);
  query = signal<{ business?: string; account?: string }>({});
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  updateQuery = jasmine.createSpy('updateQuery').and.callFake((partial: object) => {
    this.query.set({ ...this.query(), ...partial });
    return Promise.resolve();
  });
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

class FakeSelectedBusinessStore {
  selectedBusinessId = signal<string | null>('biz-1');
  items = signal([
    {
      id: 'biz-1',
      client: 'client-1',
      vertical: 'shuttle',
      name: 'Verify Shuttle',
      currency: 'NGN',
      timezone: 'Africa/Lagos',
      booking_mode_default: 'reservation',
      kyb_status: 'approved',
      kyb_submitted_at: null,
      created_at: '2026-08-01T00:00:00Z',
    },
  ]);
}

describe('LedgerOverview', () => {
  let fixture: ComponentFixture<LedgerOverview>;
  let store: FakeLedgerEntryStore;
  let apiClient: { GET: jasmine.Spy };

  beforeEach(async () => {
    store = new FakeLedgerEntryStore();
    apiClient = { GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 1, results: [makeAccount()] } }) };

    await TestBed.configureTestingModule({
      imports: [LedgerOverview],
      providers: [
        { provide: LedgerEntryStore, useValue: store },
        { provide: SelectedBusinessStore, useValue: new FakeSelectedBusinessStore() },
        { provide: API_CLIENT, useValue: apiClient },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(LedgerOverview);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('scopes the entries query and fetches accounts for the active Business on init', () => {
    expect(store.updateQuery).toHaveBeenCalledWith({ business: 'biz-1', account: undefined });
    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/ledger/accounts/',
      jasmine.objectContaining({ params: { query: { business: 'biz-1', limit: 100, offset: 0 } } })
    );
  });

  it('renders the business_clearing balance as the headline stat', () => {
    const stat = fixture.debugElement.query(By.css('ui-stat'));
    expect(stat.nativeElement.textContent).toContain('NGN 2500.00');
  });

  it('shows a fallback hint when the business has no clearing account yet', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });
    fixture = TestBed.createComponent(LedgerOverview);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const stat = fixture.debugElement.query(By.css('ui-stat'));
    expect(stat.nativeElement.textContent).toContain('No clearing account exists yet');
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No ledger entries found');
  });

  it('renders each entry with its type, memo, and labeled lines', () => {
    store.items.set([makeJournalEntry()]);
    fixture.detectChanges();

    const row = fixture.debugElement.query(By.css('tbody tr'));
    expect(row.nativeElement.textContent).toContain('Payment');
    expect(row.nativeElement.textContent).toContain('Trip fare');
    expect(row.nativeElement.textContent).toContain('Business clearing');
    expect(row.nativeElement.textContent).toContain('1500.00');
  });

  it('shows the server error message instead of the table', () => {
    store.error.set('Failed to load ledger entries.');
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('table'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Failed to load ledger entries.');
  });

  it('calls store.updateQuery() with the chosen account filter', () => {
    const select: HTMLSelectElement = fixture.debugElement.query(By.css('select')).nativeElement;
    select.value = 'acct-clearing';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(store.updateQuery).toHaveBeenCalledWith({ account: 'acct-clearing' });
  });
});
