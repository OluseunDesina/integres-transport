import { Dialog } from '@angular/cdk/dialog';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';
import { DrawerService, expectColumnVisibilityParity } from '@shared-ui';
import type { ConfirmDialogData } from '@shared-ui';
import { Subject } from 'rxjs';

import { StopList } from './stop-list';
import { BusinessStore, type Business } from '../../shared/data/store/business.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { StopStore, type Stop } from '../../shared/data/store/stop.store';

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

function makeStop(overrides: Partial<Stop> = {}): Stop {
  return {
    id: 'stop-1',
    business: 'biz-1',
    name: 'Ikeja Bus Park',
    address: '12 Awolowo Rd',
    latitude: null,
    longitude: null,
    is_active: true,
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeStopStore {
  items = signal<Stop[]>([]);
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

describe('StopList', () => {
  let fixture: ComponentFixture<StopList>;
  let store: FakeStopStore;
  let authStore: AuthStore;

  let dialogSpy: jasmine.SpyObj<Dialog>;
  let drawerSpy: jasmine.SpyObj<DrawerService>;
  let closedSubject: Subject<boolean | undefined>;

  beforeEach(async () => {
    localStorage.clear();
    apiClientStub.PATCH.calls.reset();
    closedSubject = new Subject<boolean | undefined>();
    dialogSpy = jasmine.createSpyObj<Dialog>('Dialog', ['open']);
    dialogSpy.open.and.returnValue({
      closed: closedSubject.asObservable(),
    } as ReturnType<Dialog['open']>);
    drawerSpy = jasmine.createSpyObj<DrawerService>('DrawerService', ['open']);
    store = new FakeStopStore();

    await TestBed.configureTestingModule({
      imports: [StopList],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: apiClientStub },
        { provide: Dialog, useValue: dialogSpy },
        { provide: DrawerService, useValue: drawerSpy },
        { provide: StopStore, useValue: store },
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
      makeUser({ permissions: ['client-admin:access', 'network.view'] })
    );

    fixture = TestBed.createComponent(StopList);
    fixture.detectChanges();
  });

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

    expect(fixture.nativeElement.textContent).toContain('No stops yet');
  });

  it('renders a row per stop', () => {
    store.items.set([makeStop(), makeStop({ id: 'stop-2', name: 'Second Stop' })]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0].nativeElement.textContent).toContain('Ikeja Bus Park');
  });

  it('shows the server error message instead of the table', () => {
    store.error.set('Failed to load stops.');
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('table'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Failed to load stops.');
  });

  it('hides the "New stop" button without network.manage permission', () => {
    const buttons = fixture.debugElement
      .queryAll(By.css('button'))
      .map((el) => (el.nativeElement.textContent as string).trim());
    expect(buttons).not.toContain('New stop');
  });

  it('shows the "New stop" button with network.manage permission', () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({
        permissions: ['client-admin:access', 'network.view', 'network.manage'],
      })
    );
    fixture.detectChanges();

    const buttons = fixture.debugElement
      .queryAll(By.css('button'))
      .map((el) => (el.nativeElement.textContent as string).trim());
    expect(buttons).toContain('New stop');
  });

  it('navigates to /stops/new when "New stop" is pressed', async () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({
        permissions: ['client-admin:access', 'network.view', 'network.manage'],
      })
    );
    fixture.detectChanges();
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

    const button = fixture.debugElement
      .queryAll(By.css('button'))
      .find((el) => (el.nativeElement.textContent as string).trim() === 'New stop');
    button?.nativeElement.click();
    await fixture.whenStable();

    expect(navigateSpy).toHaveBeenCalledWith(['/stops/new']);
  });

  it('calls store.changePage() when the paginator emits', () => {
    store.items.set([makeStop()]);
    store.total.set(30);
    fixture.detectChanges();

    const buttons = fixture.debugElement.queryAll(By.css('button'));
    const nextButton = buttons.find((b) =>
      (b.nativeElement.textContent as string).includes('Next')
    );
    nextButton?.nativeElement.click();

    expect(store.changePage).toHaveBeenCalledWith(25);
  });

  // --- docs/specs/14 slice 3a: toggle becomes pill + confirmed action ---

  it('renders status as a read-only pill, with no switch in the table', () => {
    // A write control in a read surface is one mis-tap from a change
    // nobody confirmed.
    store.items.set([makeStop()]);
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('tbody [role="switch"]'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Active');
  });

  it('offers a manager Edit and Deactivate for an active row', () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({
        permissions: ['client-admin:access', 'network.view', 'network.manage'],
      })
    );
    store.items.set([makeStop()]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).toEqual([
      'View details',
      'Edit',
      'Deactivate',
    ]);
  });

  it('gives a view-only user no write actions', () => {
    store.items.set([makeStop()]);
    fixture.detectChanges();

    expect(openRowMenu().map((el) => el.textContent?.trim())).toEqual(['View details']);
  });

  it('confirms before deactivating, and writes only once confirmed', async () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({
        permissions: ['client-admin:access', 'network.view', 'network.manage'],
      })
    );
    store.items.set([makeStop()]);
    fixture.detectChanges();

    await chooseAction('Deactivate');
    expect(dialogSpy.open).toHaveBeenCalled();
    expect(apiClientStub.PATCH).not.toHaveBeenCalled();

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.danger()).toBeTrue();
    await data.onConfirm();

    expect(apiClientStub.PATCH).toHaveBeenCalledWith('/api/v1/stops/{id}/', {
      params: { path: { id: 'stop-1' } },
      body: { is_active: false },
    });
  });

  it('opens a drawer of detail', async () => {
    store.items.set([makeStop()]);
    fixture.detectChanges();
    await chooseAction('View details');

    expect(drawerSpy.open).toHaveBeenCalled();
    expect(drawerSpy.open.calls.mostRecent().args[0].title).toBe('Ikeja Bus Park');
  });

  // --- Filters ---

  it('sends a debounced search to the store, scoped to the active Business', fakeAsync(() => {
    store.updateQuery.calls.reset();
    typeSearch('Ikeja');
    expect(store.updateQuery).not.toHaveBeenCalled();

    tick(300);
    expect(store.updateQuery).toHaveBeenCalledWith({
      business: 'biz-1',
      search: 'Ikeja',
      is_active: undefined,
    });
  }));

  it('says "no matches" rather than "none yet" when a filter is active', fakeAsync(() => {
    typeSearch('nothing matches');
    tick(300);
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('match these filters');
  }));
  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makeStop(), makeStop({ id: 'stop-2' })]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'stop-list rows');
  });

  it('keeps the skeleton row aligned with the header too', () => {
    store.loading.set(true);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'stop-list skeleton');
  });
});
