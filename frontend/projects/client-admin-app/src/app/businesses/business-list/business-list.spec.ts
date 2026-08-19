import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { BusinessList } from './business-list';
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
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

describe('BusinessList', () => {
  let fixture: ComponentFixture<BusinessList>;
  let store: FakeBusinessStore;
  let authStore: AuthStore;

  beforeEach(async () => {
    localStorage.clear();
    store = new FakeBusinessStore();

    await TestBed.configureTestingModule({
      imports: [BusinessList],
      providers: [provideRouter([]), { provide: BusinessStore, useValue: store }],
    }).compileComponents();

    authStore = TestBed.inject(AuthStore);
    authStore.setSession(
      'a',
      'r',
      makeUser({ permissions: ['client-admin:access', 'client.view'] })
    );

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

    expect(fixture.nativeElement.textContent).toContain('No businesses yet');
  });

  it('renders a row per business', () => {
    store.items.set([makeBusiness(), makeBusiness({ id: 'biz-2', name: 'Second Co' })]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0].nativeElement.textContent).toContain('Acme Shuttle Co');
  });

  it('shows the server error message instead of the table', () => {
    store.error.set('Failed to load businesses.');
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('table'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Failed to load businesses.');
  });

  it('hides the "New business" button without business.manage permission', () => {
    const buttons = fixture.debugElement
      .queryAll(By.css('button'))
      .map((el) => (el.nativeElement.textContent as string).trim());
    expect(buttons).not.toContain('New business');
  });

  it('shows the "New business" button with business.manage permission', () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({ permissions: ['client-admin:access', 'client.view', 'business.manage'] })
    );
    fixture.detectChanges();

    const buttons = fixture.debugElement
      .queryAll(By.css('button'))
      .map((el) => (el.nativeElement.textContent as string).trim());
    expect(buttons).toContain('New business');
  });

  it('navigates to /businesses/new when "New business" is pressed', async () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({ permissions: ['client-admin:access', 'client.view', 'business.manage'] })
    );
    fixture.detectChanges();
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

    const button = fixture.debugElement
      .queryAll(By.css('button'))
      .find((el) => (el.nativeElement.textContent as string).trim() === 'New business');
    button?.nativeElement.click();
    await fixture.whenStable();

    expect(navigateSpy).toHaveBeenCalledWith(['/businesses/new']);
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
