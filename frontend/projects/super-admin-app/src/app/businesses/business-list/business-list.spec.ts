import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

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

describe('BusinessList', () => {
  let fixture: ComponentFixture<BusinessList>;
  let store: FakeBusinessSuperAdminStore;

  beforeEach(async () => {
    store = new FakeBusinessSuperAdminStore();

    await TestBed.configureTestingModule({
      imports: [BusinessList],
      providers: [provideRouter([]), { provide: BusinessSuperAdminStore, useValue: store }],
    }).compileComponents();

    fixture = TestBed.createComponent(BusinessList);
    fixture.detectChanges();
  });

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

  it('calls store.updateQuery() with the trimmed search term on submit', () => {
    fixture.componentInstance['onSearchTermChange']('  Lagos  ');
    fixture.componentInstance['onSearchSubmit']();

    expect(store.updateQuery).toHaveBeenCalledWith({ search: 'Lagos' });
  });

  it('sends an undefined search when the field is cleared', () => {
    fixture.componentInstance['onSearchTermChange']('   ');
    fixture.componentInstance['onSearchSubmit']();

    expect(store.updateQuery).toHaveBeenCalledWith({ search: undefined });
  });

  it('links each row to its Paystack and Settlements screens', () => {
    store.items.set([makeBusiness()]);
    fixture.detectChanges();

    const links = fixture.debugElement.queryAll(By.css('tbody tr a'));
    expect(links[0].nativeElement.getAttribute('href')).toBe('/businesses/biz-1/paystack-account');
    expect(links[1].nativeElement.getAttribute('href')).toBe('/businesses/biz-1/settlement-runs');
  });

  it('calls store.changePage() when the paginator emits', () => {
    store.items.set([makeBusiness()]);
    store.total.set(30);
    fixture.detectChanges();

    const buttons = fixture.debugElement.queryAll(By.css('button'));
    const nextButton = buttons.find((b) => (b.nativeElement.textContent as string).includes('Next'));
    nextButton?.nativeElement.click();

    expect(store.changePage).toHaveBeenCalledWith(25);
  });
});
