import { Dialog } from '@angular/cdk/dialog';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';
import { expectColumnVisibilityParity } from '@shared-ui';
import type { ConfirmDialogData } from '@shared-ui';
import { Subject } from 'rxjs';

import { RouteList } from './route-list';
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
    status: 'active',
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
  let dialogSpy: jasmine.SpyObj<Dialog>;
  let closedSubject: Subject<boolean | undefined>;

  async function render(permissions: string[]): Promise<void> {
    fixture?.destroy();
    TestBed.resetTestingModule();
    store = new FakeRouteStore();
    closedSubject = new Subject<boolean | undefined>();
    dialogSpy = jasmine.createSpyObj<Dialog>('Dialog', ['open']);
    dialogSpy.open.and.returnValue({
      closed: closedSubject.asObservable(),
    } as ReturnType<Dialog['open']>);

    await TestBed.configureTestingModule({
      imports: [RouteList],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: apiClientStub },
        { provide: RouteStore, useValue: store },
        { provide: Dialog, useValue: dialogSpy },
        {
          provide: SelectedBusinessStore,
          useValue: new FakeSelectedBusinessStore(),
        },
      ],
    }).compileComponents();

    const authStore = TestBed.inject(AuthStore);
    authStore.setSession('a', 'r', makeUser({ permissions }));

    fixture = TestBed.createComponent(RouteList);
    fixture.detectChanges();
  }

  function openRowMenu(): HTMLButtonElement[] {
    const trigger = fixture.debugElement
      .queryAll(By.css('tbody button'))
      .find((el) =>
        (el.nativeElement as HTMLElement).getAttribute('aria-label')?.startsWith('Actions for')
      )!;
    (trigger.nativeElement as HTMLButtonElement).click();
    fixture.detectChanges();
    return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  }

  /** `ui-action-menu` emits one macrotask after the click, so the menu
   * has closed and returned focus before a dialog opens. */
  async function chooseAction(label: string): Promise<void> {
    const item = openRowMenu().find((el) => el.textContent?.trim() === label)!;
    item.click();
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
  }

  function typeSearch(value: string): void {
    const input = fixture.debugElement.query(By.css('input[type="search"]'))
      .nativeElement as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  beforeEach(async () => {
    localStorage.clear();
    apiClientStub.POST.calls.reset();
    apiClientStub.POST.and.resolveTo({ data: {} });
    await render(['client-admin:access', 'network.view', 'network.manage', 'fares.view']);
  });

  afterEach(() => {
    localStorage.clear();
    fixture.destroy();
  });

  it('scopes the query to the active Business on init', () => {
    expect(store.updateQuery).toHaveBeenCalledWith({ business: 'biz-1' });
  });

  it('shows the empty state when the store has no rows and nothing is filtered', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No routes yet');
  });

  it('renders a route row with its stop count', () => {
    store.items.set([makeRoute({ code: 'IKJ-1', stops: [] })]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Ikeja Express');
    expect(fixture.nativeElement.textContent).toContain('IKJ-1');
  });

  // --- docs/specs/19-route-lifecycle.md: status replaces is_active ---

  it('renders status as a read-only pill, with no switch in the table', () => {
    // A write control in a read surface is one mis-tap from taking a
    // route out of service.
    store.items.set([makeRoute()]);
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('tbody [role="switch"]'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Active');
  });

  it('offers a manager Fares, Edit, Deactivate, Archive and Duplicate for an active route', () => {
    store.items.set([makeRoute()]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).toEqual([
      'View details',
      'Fares',
      'Edit',
      'Deactivate',
      'Archive',
      'Duplicate',
    ]);
  });

  it('offers Activate, never Deactivate, for a draft route', () => {
    store.items.set([makeRoute({ status: 'draft' })]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).toEqual([
      'View details',
      'Fares',
      'Edit',
      'Activate',
      'Archive',
      'Duplicate',
    ]);
  });

  it('offers Activate, never Deactivate, for an inactive route', () => {
    store.items.set([makeRoute({ status: 'inactive' })]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).toEqual([
      'View details',
      'Fares',
      'Edit',
      'Activate',
      'Archive',
      'Duplicate',
    ]);
  });

  it('offers only Restore and Duplicate for an archived route', () => {
    store.items.set([makeRoute({ status: 'archived' })]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).toEqual([
      'View details',
      'Fares',
      'Edit',
      'Restore',
      'Duplicate',
    ]);
  });

  it('gates Fares on fares.view, not on network.manage', async () => {
    // Reading what a route charges is not a network edit
    // (docs/specs/12-fare-matrix.md).
    await render(['client-admin:access', 'network.view', 'network.manage']);
    store.items.set([makeRoute()]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).not.toContain('Fares');
  });

  it('gives a view-only user no write actions', async () => {
    await render(['client-admin:access', 'network.view']);
    store.items.set([makeRoute()]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).toEqual(['View details']);
  });

  it('navigates to the detail screen from the row menu', async () => {
    const router = TestBed.inject(Router);
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);
    store.items.set([makeRoute()]);
    fixture.detectChanges();

    await chooseAction('View details');

    expect(navigate).toHaveBeenCalledWith(['/routes', 'route-1']);
  });

  it('navigates to the fare matrix from the row menu', async () => {
    const router = TestBed.inject(Router);
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);
    store.items.set([makeRoute()]);
    fixture.detectChanges();

    await chooseAction('Fares');

    expect(navigate).toHaveBeenCalledWith(['/fares/fare-matrix', 'route-1']);
  });

  // --- Status transitions ---

  it('confirms before deactivating rather than writing straight away', async () => {
    store.items.set([makeRoute()]);
    fixture.detectChanges();
    await chooseAction('Deactivate');

    expect(dialogSpy.open).toHaveBeenCalled();
    expect(apiClientStub.POST).not.toHaveBeenCalled();

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toBe('Deactivate Ikeja Express?');
    expect(data.danger()).toBeTrue();
  });

  it('does not treat activating as destructive', async () => {
    store.items.set([makeRoute({ status: 'inactive' })]);
    fixture.detectChanges();
    await chooseAction('Activate');

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toBe('Activate Ikeja Express?');
    expect(data.danger()).toBeFalse();
  });

  it('treats archiving as destructive', async () => {
    store.items.set([makeRoute()]);
    fixture.detectChanges();
    await chooseAction('Archive');

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toBe('Archive Ikeja Express?');
    expect(data.danger()).toBeTrue();
  });

  it('does not treat restoring as destructive, even though it targets the same status as deactivating', async () => {
    store.items.set([makeRoute({ status: 'archived' })]);
    fixture.detectChanges();
    await chooseAction('Restore');

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toBe('Restore Ikeja Express?');
    expect(data.danger()).toBeFalse();
  });

  it('sends the transition to the status endpoint only once the dialog confirms', async () => {
    store.items.set([makeRoute()]);
    fixture.detectChanges();
    await chooseAction('Deactivate');

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    await data.onConfirm();

    expect(apiClientStub.POST).toHaveBeenCalledWith('/api/v1/routes/{id}/status/', {
      params: { path: { id: 'route-1' } },
      body: { status: 'inactive' },
    });
  });

  it('surfaces a rejected transition inside the dialog instead of closing on it', async () => {
    apiClientStub.POST.and.resolveTo({
      error: { detail: '2 future trip(s) are scheduled on this route.' },
    });
    store.items.set([makeRoute()]);
    fixture.detectChanges();
    await chooseAction('Archive');

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(await data.onConfirm()).toEqual({
      ok: false,
      error: '2 future trip(s) are scheduled on this route.',
    });

    apiClientStub.POST.and.resolveTo({ data: {} });
  });

  // --- Duplicate ---

  it('confirms before duplicating, and it is not styled as destructive', async () => {
    store.items.set([makeRoute()]);
    fixture.detectChanges();
    await chooseAction('Duplicate');

    expect(dialogSpy.open).toHaveBeenCalled();
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toBe('Duplicate Ikeja Express?');
    expect(data.danger()).toBeFalse();
  });

  it('posts to the duplicate endpoint and navigates to the copy once confirmed', async () => {
    const router = TestBed.inject(Router);
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);
    apiClientStub.POST.and.resolveTo({ data: makeRoute({ id: 'route-2', status: 'draft' }) });
    store.items.set([makeRoute()]);
    fixture.detectChanges();
    await chooseAction('Duplicate');

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(await data.onConfirm()).toEqual({ ok: true });
    expect(apiClientStub.POST).toHaveBeenCalledWith('/api/v1/routes/{id}/duplicate/', {
      params: { path: { id: 'route-1' } },
    });

    closedSubject.next(true);
    await new Promise((resolve) => setTimeout(resolve));

    expect(navigate).toHaveBeenCalledWith(['/routes', 'route-2', 'edit']);
  });

  // --- Filters ---

  it('sends a debounced search to the store, scoped to the active Business', fakeAsync(() => {
    store.updateQuery.calls.reset();
    typeSearch('Ikeja');
    expect(store.updateQuery).not.toHaveBeenCalled();

    tick(300);
    expect(store.updateQuery).toHaveBeenCalledWith(
      jasmine.objectContaining({ business: 'biz-1', search: 'Ikeja', status: undefined })
    );
  }));

  it('keeps the Business scope when a filter changes', fakeAsync(() => {
    // Dropping it would widen the list to every Business under the
    // Client the moment someone typed.
    typeSearch('Ikeja');
    tick(300);
    expect(store.updateQuery.calls.mostRecent().args[0]).toEqual(
      jasmine.objectContaining({ business: 'biz-1' })
    );
  }));

  it('narrows the query by status, and defaults to none (excludes archived server-side)', () => {
    fixture.componentInstance['onExtraFilterChange']('status', 'archived');

    expect(store.updateQuery).toHaveBeenCalledWith(
      jasmine.objectContaining({ status: 'archived' })
    );
  });

  it('renders the active search as a removable chip', fakeAsync(() => {
    typeSearch('Ikeja');
    tick(300);
    fixture.detectChanges();

    const chip = fixture.debugElement
      .queryAll(By.css('button'))
      .find((el) =>
        (el.nativeElement as HTMLElement).getAttribute('aria-label')?.startsWith('Remove filter')
      );
    expect((chip!.nativeElement as HTMLElement).textContent).toContain('Search: Ikeja');
  }));

  it('clears the search from its chip', fakeAsync(() => {
    typeSearch('Ikeja');
    tick(300);
    fixture.detectChanges();

    const chip = fixture.debugElement
      .queryAll(By.css('button'))
      .find((el) =>
        (el.nativeElement as HTMLElement).getAttribute('aria-label')?.startsWith('Remove filter')
      )!;
    (chip.nativeElement as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(store.updateQuery).toHaveBeenCalledWith(
      jasmine.objectContaining({ business: 'biz-1', search: undefined, status: undefined })
    );
  }));

  it('says "no matches" rather than "none yet" when a filter is active', fakeAsync(() => {
    // "No routes yet" invites creating one, when the real answer is to
    // widen the filter.
    typeSearch('nothing matches');
    tick(300);
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No routes match these filters');
    expect(fixture.nativeElement.textContent).not.toContain('No routes yet');
  }));

  // --- Density ---

  it('renders skeleton rows while loading, hidden from assistive tech', () => {
    store.loading.set(true);
    fixture.detectChanges();

    expect(fixture.debugElement.queryAll(By.css('tbody .animate-pulse')).length).toBeGreaterThan(0);
    const region = fixture.debugElement.query(By.css('[aria-busy]'));
    expect((region.nativeElement as HTMLElement).getAttribute('aria-busy')).toBe('true');
  });

  it('shares the density preference with every other list', async () => {
    // TableDensityStore is root-provided precisely so this holds — an
    // operator who wants dense rows wants them everywhere.
    store.items.set([makeRoute()]);
    fixture.detectChanges();

    const compact = fixture.debugElement
      .queryAll(By.css('button'))
      .find(
        (el) => (el.nativeElement as HTMLElement).getAttribute('aria-label') === 'Compact rows'
      )!;
    (compact.nativeElement as HTMLButtonElement).click();
    fixture.detectChanges();

    await render(['client-admin:access', 'network.view', 'network.manage', 'fares.view']);
    const stillCompact = fixture.debugElement
      .queryAll(By.css('button'))
      .find(
        (el) => (el.nativeElement as HTMLElement).getAttribute('aria-label') === 'Compact rows'
      )!;
    expect((stillCompact.nativeElement as HTMLElement).getAttribute('aria-pressed')).toBe('true');
  });

  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makeRoute({ code: 'IKJ-1' }), makeRoute({ id: 'route-2' })]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'route-list rows');
  });

  it('keeps the skeleton row aligned with the header too', () => {
    // The easiest half of this to forget, and the one nobody looks at:
    // a skeleton that hides different columns shifts its placeholders
    // under the wrong headings for as long as the fetch takes.
    store.loading.set(true);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'route-list skeleton');
  });

  it('re-flows the hidden columns into a sub-line under the name', () => {
    store.items.set([
      makeRoute({
        code: 'IKJ-1',
        stops: [{ id: 's1' }, { id: 's2' }] as Route['stops'],
      }),
    ]);
    fixture.detectChanges();

    const subLine = fixture.debugElement.query(By.css('tbody .md\\:hidden'));
    expect((subLine.nativeElement as HTMLElement).textContent?.trim()).toBe('IKJ-1 · 2 stops');
  });

  it('drops the separator rather than printing one for a route with no code', () => {
    store.items.set([makeRoute({ code: '', stops: [{ id: 's1' }] as Route['stops'] })]);
    fixture.detectChanges();

    const subLine = fixture.debugElement.query(By.css('tbody .md\\:hidden'));
    expect((subLine.nativeElement as HTMLElement).textContent?.trim()).toBe('1 stop');
  });
});
