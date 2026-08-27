import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { RouteList } from './route-list';
import { BusinessStore, type Business } from '../../shared/data/store/business.store';
import { RouteStore, type Route } from '../../shared/data/store/route.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

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

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    id: 'route-1',
    business: 'biz-1',
    name: 'Ikeja Express',
    code: '',
    description: '',
    is_active: true,
    stops: [],
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeRouteStore {
  items = signal<Route[]>([]);
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  updateQuery = jasmine.createSpy('updateQuery').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
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

class FakeSelectedBusinessStore {
  selectedBusinessId = signal<string | null>('biz-1');
}

const apiClientStub = {
  GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
  POST: jasmine.createSpy('POST').and.resolveTo({ data: {} }),
  PATCH: jasmine.createSpy('PATCH').and.resolveTo({ data: {} }),
};

describe('RouteList', () => {
  let fixture: ComponentFixture<RouteList>;
  let store: FakeRouteStore;
  let authStore: AuthStore;

  beforeEach(async () => {
    localStorage.clear();
    store = new FakeRouteStore();

    await TestBed.configureTestingModule({
      imports: [RouteList],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: apiClientStub },
        { provide: RouteStore, useValue: store },
        { provide: BusinessStore, useValue: new FakeBusinessStore() },
        {
          provide: SelectedBusinessStore,
          useValue: new FakeSelectedBusinessStore(),
        },
      ],
    }).compileComponents();

    authStore = TestBed.inject(AuthStore);
    authStore.setSession(
      'a',
      'r',
      makeUser({ permissions: ['client-admin:access', 'network.view'] }),
    );

    fixture = TestBed.createComponent(RouteList);
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('scopes the query to the active Business on init', () => {
    expect(store.updateQuery).toHaveBeenCalledWith({ business: 'biz-1' });
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No routes yet');
  });

  it('renders a row per route', () => {
    store.items.set([makeRoute(), makeRoute({ id: 'route-2', name: 'Second Route' })]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0].nativeElement.textContent).toContain('Ikeja Express');
  });

  it('shows the server error message instead of the table', () => {
    store.error.set('Failed to load routes.');
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('table'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Failed to load routes.');
  });

  it('hides the "New route" button without network.manage permission', () => {
    const buttons = fixture.debugElement
      .queryAll(By.css('button'))
      .map((el) => (el.nativeElement.textContent as string).trim());
    expect(buttons).not.toContain('New route');
  });

  it('shows the "New route" button with network.manage permission', () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({
        permissions: ['client-admin:access', 'network.view', 'network.manage'],
      }),
    );
    fixture.detectChanges();

    const buttons = fixture.debugElement
      .queryAll(By.css('button'))
      .map((el) => (el.nativeElement.textContent as string).trim());
    expect(buttons).toContain('New route');
  });

  it('navigates to /routes/new when "New route" is pressed', async () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({
        permissions: ['client-admin:access', 'network.view', 'network.manage'],
      }),
    );
    fixture.detectChanges();
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

    const button = fixture.debugElement
      .queryAll(By.css('button'))
      .find((el) => (el.nativeElement.textContent as string).trim() === 'New route');
    button?.nativeElement.click();
    await fixture.whenStable();

    expect(navigateSpy).toHaveBeenCalledWith(['/routes/new']);
  });

  it('calls store.changePage() when the paginator emits', () => {
    store.items.set([makeRoute()]);
    store.total.set(30);
    fixture.detectChanges();

    const buttons = fixture.debugElement.queryAll(By.css('button'));
    const nextButton = buttons.find((b) =>
      (b.nativeElement.textContent as string).includes('Next'),
    );
    nextButton?.nativeElement.click();

    expect(store.changePage).toHaveBeenCalledWith(25);
  });

  describe('activate/deactivate switch', () => {
    function switchEl(): HTMLButtonElement | undefined {
      return fixture.debugElement.query(By.css('button[role="switch"]'))?.nativeElement as
        HTMLButtonElement | undefined;
    }

    beforeEach(() => {
      apiClientStub.PATCH.calls.reset();
      apiClientStub.PATCH.and.resolveTo({
        data: makeRoute({ is_active: false }),
      });
      authStore.setSession(
        'a',
        'r',
        makeUser({
          permissions: ['client-admin:access', 'network.view', 'network.manage'],
        }),
      );
      store.items.set([makeRoute()]);
      fixture.detectChanges();
    });

    it('PATCHes the row with the requested state and refetches', async () => {
      switchEl()?.click();
      await fixture.whenStable();

      expect(apiClientStub.PATCH).toHaveBeenCalledWith(
        '/api/v1/routes/{id}/',
        jasmine.objectContaining({
          params: { path: { id: 'route-1' } },
          body: { is_active: false },
        }),
      );
      expect(store.getAll).toHaveBeenCalled();
    });

    it('surfaces a failed toggle without hiding the table', async () => {
      apiClientStub.PATCH.and.resolveTo({
        error: { detail: 'Route is in use.' },
      });

      switchEl()?.click();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.componentInstance['activeError']()).toBe('Route is in use.');
      // The row must still be on screen — the switch has rolled back and
      // the user needs to see what failed.
      expect(fixture.nativeElement.textContent).toContain('Ikeja Express');
    });

    it('shows a read-only pill instead of a switch without network.manage', () => {
      authStore.setSession(
        'a',
        'r',
        makeUser({ permissions: ['client-admin:access', 'network.view'] }),
      );
      fixture.detectChanges();

      expect(switchEl()).toBeUndefined();
      expect(fixture.nativeElement.textContent).toContain('Active');
    });
  });
});
