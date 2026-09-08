import { signal } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { expectColumnVisibilityParity } from '@shared-ui';

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

  // --- Search, now through ui-filter-bar (docs/specs/14 slice 2) ---
  //
  // Driven through the rendered input rather than the component method,
  // per the lesson recorded in docs/self-check-2026-08-26-spec11.md: a
  // test that calls the handler directly passes whether or not the
  // control is actually wired to it.

  function typeSearch(value: string): void {
    const input = fixture.debugElement.query(By.css('input[type="search"]'))
      .nativeElement as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('queries the store with the trimmed search term once the debounce elapses', fakeAsync(() => {
    typeSearch('  Lagos  ');
    tick(300);

    expect(store.updateQuery).toHaveBeenCalledWith({ search: 'Lagos' });
  }));

  it('does not query the store on every keystroke', fakeAsync(() => {
    // The whole reason this screen submitted on a button before: an
    // undebounced box is one cross-client query per character.
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

    expect(store.updateQuery).toHaveBeenCalledWith({ search: undefined });
  }));

  it('renders the active search as a removable chip', fakeAsync(() => {
    // A filtered list with nothing on screen saying so is
    // indistinguishable from a list with no data.
    typeSearch('Lagos');
    tick(300);
    fixture.detectChanges();

    const chip = fixture.debugElement
      .queryAll(By.css('button'))
      .find((el) =>
        (el.nativeElement as HTMLElement).getAttribute('aria-label')?.startsWith('Remove filter'),
      );
    expect(chip).toBeDefined();
    expect((chip!.nativeElement as HTMLElement).textContent).toContain('Name: Lagos');
  }));

  it('clears the search from the chip, restoring the unfiltered list', fakeAsync(() => {
    typeSearch('Lagos');
    tick(300);
    fixture.detectChanges();

    const chip = fixture.debugElement
      .queryAll(By.css('button'))
      .find((el) =>
        (el.nativeElement as HTMLElement).getAttribute('aria-label')?.startsWith('Remove filter'),
      )!;
    (chip.nativeElement as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(store.updateQuery).toHaveBeenCalledWith({ search: undefined });
    const input = fixture.debugElement.query(By.css('input[type="search"]'))
      .nativeElement as HTMLInputElement;
    expect(input.value).toBe('');
  }));

  it('shows a search-specific empty state rather than the generic one', fakeAsync(() => {
    typeSearch('Nothing matches this');
    tick(300);
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No business matches that name');
  }));

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
  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makeBusiness()]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'business-list');
  });

});
