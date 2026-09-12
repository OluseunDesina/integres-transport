import { BreakpointObserver } from '@angular/cdk/layout';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthApiService, AuthStore } from '@auth';
import type { AuthUser } from '@auth';
import { of } from 'rxjs';

import { NavShell } from './nav-shell';

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

@Component({
  imports: [NavShell],
  template: `<app-nav-shell
    appName="Client Admin"
    [navItems]="navItems"
    [businesses]="businesses"
    [activeBusinessId]="activeBusinessId"
    [quickActions]="quickActions"
    (businessSelected)="onBusinessSelected($event)"
  />`,
})
class HostComponent {
  navItems = [
    { label: 'Home', path: '/home', icon: 'home' as const, permissions: [] },
    { label: 'Businesses', path: '/businesses', icon: 'building-office' as const, permissions: ['business.manage'] },
  ];
  businesses: { id: string; name: string }[] = [];
  activeBusinessId: string | null = null;
  quickActions: { label: string; path: string; permissions: readonly string[] }[] = [];
  selectedBusinessId: string | null = null;

  onBusinessSelected(id: string): void {
    this.selectedBusinessId = id;
  }
}

// A fake BreakpointObserver defaulting to "wide" (matches: false) so
// every existing assertion (label text visible, app name/email
// visible) keeps meaning what it already meant, independent of
// whatever width Karma's actual browser window happens to be — the
// real BreakpointObserver would make these tests environment-dependent.
function fakeBreakpointObserver(matches: boolean): Partial<BreakpointObserver> {
  return { observe: () => of({ matches, breakpoints: {} }) };
}

async function setup(matches = false): Promise<{
  fixture: ComponentFixture<HostComponent>;
  authApi: jasmine.SpyObj<AuthApiService>;
}> {
  const authApi = jasmine.createSpyObj<AuthApiService>('AuthApiService', ['login', 'logout']);
  // NavShell now always renders NotificationBell in its header, which
  // fetches on init — a resolved-empty GET keeps every existing
  // assertion in this file meaning what it already meant.
  const apiClient = {
    GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
    POST: jasmine.createSpy('POST'),
  };

  await TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [
      provideRouter([{ path: 'home', children: [] }]),
      { provide: AuthApiService, useValue: authApi },
      { provide: BreakpointObserver, useValue: fakeBreakpointObserver(matches) },
      { provide: API_CLIENT, useValue: apiClient },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(HostComponent);
  return { fixture, authApi };
}

function findButtonByText(fixture: ComponentFixture<HostComponent>, text: string) {
  return fixture.debugElement
    .queryAll(By.css('button'))
    .find((el) => (el.nativeElement.textContent as string).includes(text));
}

// NotificationBell's own trigger also carries aria-haspopup="menu" —
// distinguish by its fixed "Notifications" aria-label, since the
// profile trigger's own aria-label varies (null when expanded, the
// user's email when collapsed).
function profileTrigger(fixture: ComponentFixture<HostComponent>) {
  const trigger = fixture.debugElement
    .queryAll(By.css('[aria-haspopup="menu"]'))
    .find((el) => el.nativeElement.getAttribute('aria-label') !== 'Notifications');
  if (!trigger) {
    throw new Error('Profile trigger not found');
  }
  return trigger;
}

function openProfileMenu(fixture: ComponentFixture<HostComponent>): void {
  profileTrigger(fixture).nativeElement.click();
  fixture.detectChanges();
}

describe('NavShell', () => {
  let fixture: ComponentFixture<HostComponent>;
  let authStore: AuthStore;
  let authApi: jasmine.SpyObj<AuthApiService>;

  afterEach(() => localStorage.clear());

  describe('expanded (wide viewport)', () => {
    beforeEach(async () => {
      localStorage.clear();
      ({ fixture, authApi } = await setup(false));
      authStore = TestBed.inject(AuthStore);
    });

    it('renders the app name and signed-in email', () => {
      authStore.setSession('a', 'r', makeUser({ permissions: ['client-admin:access'] }));
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain('Client Admin');
      expect(fixture.nativeElement.textContent).toContain('owner@example.com');
    });

    it('hides nav items the user lacks permission for', () => {
      authStore.setSession('a', 'r', makeUser({ permissions: ['client-admin:access'] }));
      fixture.detectChanges();

      const links = fixture.debugElement.queryAll(By.css('nav a')).map((el) => el.nativeElement.textContent);
      expect(links.some((text) => text.includes('Home'))).toBeTrue();
      expect(links.some((text) => text.includes('Businesses'))).toBeFalse();
    });

    it('shows nav items the user has permission for', () => {
      authStore.setSession(
        'a',
        'r',
        makeUser({ permissions: ['client-admin:access', 'business.manage'] })
      );
      fixture.detectChanges();

      const links = fixture.debugElement.queryAll(By.css('nav a')).map((el) => el.nativeElement.textContent);
      expect(links.some((text) => text.includes('Businesses'))).toBeTrue();
    });

    it('marks the active link with aria-current="page"', async () => {
      authStore.setSession(
        'a',
        'r',
        makeUser({ permissions: ['client-admin:access', 'business.manage'] })
      );
      fixture.detectChanges();
      const router = TestBed.inject(Router);
      await router.navigateByUrl('/home');
      fixture.detectChanges();

      const homeLink = fixture.debugElement
        .queryAll(By.css('nav a'))
        .find((el) => (el.nativeElement.textContent as string).includes('Home'));
      const businessesLink = fixture.debugElement
        .queryAll(By.css('nav a'))
        .find((el) => (el.nativeElement.textContent as string).includes('Businesses'));
      expect(homeLink?.nativeElement.getAttribute('aria-current')).toBe('page');
      expect(businessesLink?.nativeElement.getAttribute('aria-current')).toBeNull();
    });

    it('the collapse toggle starts expanded (aria-expanded="true")', () => {
      authStore.setSession('a', 'r', makeUser({ permissions: ['client-admin:access'] }));
      fixture.detectChanges();

      const toggle = fixture.debugElement.query(By.css('[aria-label="Toggle navigation width"]'));
      expect(toggle.nativeElement.getAttribute('aria-expanded')).toBe('true');
    });

    it('clicking the collapse toggle hides labels and updates aria-expanded', () => {
      authStore.setSession('a', 'r', makeUser({ permissions: ['client-admin:access'] }));
      fixture.detectChanges();

      const toggle = fixture.debugElement.query(By.css('[aria-label="Toggle navigation width"]'));
      toggle.nativeElement.click();
      fixture.detectChanges();

      expect(toggle.nativeElement.getAttribute('aria-expanded')).toBe('false');
      const homeLink = fixture.debugElement
        .queryAll(By.css('nav a'))
        .find((el) => el.nativeElement.getAttribute('aria-label') === 'Home');
      expect(homeLink).toBeTruthy();
    });

    describe('profile menu', () => {
      beforeEach(() => {
        authStore.setSession(
          'a',
          'r',
          makeUser({
            permissions: ['client-admin:access'],
            roleName: 'Owner',
            clientName: 'Acme Shuttle Co',
          })
        );
        fixture.detectChanges();
      });

      it('is closed by default', () => {
        expect(fixture.debugElement.query(By.css('[role="menu"]'))).toBeNull();
      });

      it('shows email, role, and client name once opened', () => {
        openProfileMenu(fixture);

        const menu = fixture.debugElement.query(By.css('[role="menu"]'));
        expect(menu.nativeElement.textContent).toContain('owner@example.com');
        expect(menu.nativeElement.textContent).toContain('Owner');
        expect(menu.nativeElement.textContent).toContain('Acme Shuttle Co');
      });

      it('opens on trigger click and sets aria-expanded', () => {
        const trigger = profileTrigger(fixture);
        expect(trigger.nativeElement.getAttribute('aria-expanded')).toBe('false');

        openProfileMenu(fixture);

        expect(trigger.nativeElement.getAttribute('aria-expanded')).toBe('true');
      });

      it('closes on Escape and returns focus to the trigger', () => {
        openProfileMenu(fixture);

        // Escape is caught by a document-level listener (not a template
        // binding on the panel), since opening the menu never moves
        // focus off the trigger — dispatch at the document to match.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        fixture.detectChanges();

        expect(fixture.debugElement.query(By.css('[role="menu"]'))).toBeNull();
        expect(document.activeElement).toBe(profileTrigger(fixture).nativeElement);
      });

      it('closes when clicking outside the menu', () => {
        openProfileMenu(fixture);
        expect(fixture.debugElement.query(By.css('[role="menu"]'))).toBeTruthy();

        document.body.click();
        fixture.detectChanges();

        expect(fixture.debugElement.query(By.css('[role="menu"]'))).toBeNull();
      });

      it('hides the business switcher when there are no Businesses', () => {
        openProfileMenu(fixture);

        expect(fixture.debugElement.query(By.css('[role="menuitemradio"]'))).toBeNull();
      });

      it('lists Businesses, marks the active one, and emits on selection', () => {
        fixture.componentInstance.businesses = [
          { id: 'biz-1', name: 'Lagos Shuttle' },
          { id: 'biz-2', name: 'Abuja Shuttle' },
        ];
        fixture.componentInstance.activeBusinessId = 'biz-1';
        fixture.detectChanges();
        openProfileMenu(fixture);

        const rows = fixture.debugElement.queryAll(By.css('[role="menuitemradio"]'));
        expect(rows.length).toBe(2);
        expect(rows[0].nativeElement.getAttribute('aria-checked')).toBe('true');
        expect(rows[1].nativeElement.getAttribute('aria-checked')).toBe('false');

        rows[1].nativeElement.click();
        fixture.detectChanges();

        expect(fixture.componentInstance.selectedBusinessId).toBe('biz-2');
        // Selecting closes the menu and returns focus to the trigger.
        expect(fixture.debugElement.query(By.css('[role="menu"]'))).toBeNull();
      });

      it('hides the business switcher for a non-client-staff user even with Businesses present', () => {
        authStore.setSession(
          'a',
          'r',
          makeUser({ permissions: ['super-admin:access'], isClientStaff: false })
        );
        fixture.componentInstance.businesses = [{ id: 'biz-1', name: 'Lagos Shuttle' }];
        fixture.detectChanges();
        openProfileMenu(fixture);

        expect(fixture.debugElement.query(By.css('[role="menuitemradio"]'))).toBeNull();
      });
    });

    it('calls authApi.logout() and navigates to /login on sign out', async () => {
      authStore.setSession('a', 'r', makeUser({ permissions: ['client-admin:access'] }));
      fixture.detectChanges();
      const router = TestBed.inject(Router);
      const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

      // Sign out now lives inside the closed-by-default profile menu.
      openProfileMenu(fixture);
      const signOutButton = findButtonByText(fixture, 'Sign out');
      signOutButton?.nativeElement.click();
      await fixture.whenStable();

      expect(authApi.logout).toHaveBeenCalled();
      expect(navigateSpy).toHaveBeenCalledWith(['/login']);
    });
  });

  describe('collapsed (narrow viewport)', () => {
    beforeEach(async () => {
      localStorage.clear();
      ({ fixture } = await setup(true));
      authStore = TestBed.inject(AuthStore);
      authStore.setSession('a', 'r', makeUser({ permissions: ['client-admin:access'] }));
      fixture.detectChanges();
    });

    it('hides nav-item labels but keeps them reachable via aria-label', () => {
      const homeLink = fixture.debugElement
        .queryAll(By.css('nav a'))
        .find((el) => el.nativeElement.getAttribute('aria-label') === 'Home');
      expect(homeLink).toBeTruthy();
      expect(homeLink?.nativeElement.querySelector('span')).toBeNull();
    });

    it('reports the toggle as collapsed regardless of the stored preference', () => {
      const toggle = fixture.debugElement.query(By.css('[aria-label="Toggle navigation width"]'));
      expect(toggle.nativeElement.getAttribute('aria-expanded')).toBe('false');
    });

    it('keeps the profile trigger reachable via aria-label, and Sign out inside it', () => {
      // Sign out is no longer independently reachable without opening
      // the menu first — the collapsed trigger's aria-label carries the
      // email (there's no visible text to fall back on).
      const trigger = profileTrigger(fixture);
      expect(trigger.nativeElement.getAttribute('aria-label')).toBe('owner@example.com');

      openProfileMenu(fixture);

      expect(findButtonByText(fixture, 'Sign out')).toBeTruthy();
    });
  });

  describe('mobile drawer (narrow viewport)', () => {
    function drawerTrigger(fixture: ComponentFixture<HostComponent>) {
      return fixture.debugElement.query(By.css('[aria-label="Open navigation menu"]'));
    }

    function backdrop(fixture: ComponentFixture<HostComponent>) {
      return fixture.debugElement.query(By.css('[aria-label="Close navigation menu"]'));
    }

    function aside(fixture: ComponentFixture<HostComponent>) {
      return fixture.debugElement.query(By.css('aside'));
    }

    function openDrawer(fixture: ComponentFixture<HostComponent>): void {
      drawerTrigger(fixture).nativeElement.click();
      fixture.detectChanges();
    }

    beforeEach(async () => {
      localStorage.clear();
      ({ fixture } = await setup(true));
      authStore = TestBed.inject(AuthStore);
      authStore.setSession('a', 'r', makeUser({ permissions: ['client-admin:access'] }));
      fixture.detectChanges();
    });

    it('renders a hamburger trigger only at this breakpoint', () => {
      expect(drawerTrigger(fixture)).toBeTruthy();
    });

    it('starts closed: the sidebar is inert and no backdrop is rendered', () => {
      expect(aside(fixture).nativeElement.hasAttribute('inert')).toBeTrue();
      expect(backdrop(fixture)).toBeNull();
    });

    it('opens on trigger click: sidebar loses inert, backdrop appears, aria-expanded flips', () => {
      openDrawer(fixture);

      expect(aside(fixture).nativeElement.hasAttribute('inert')).toBeFalse();
      expect(backdrop(fixture)).toBeTruthy();
      expect(drawerTrigger(fixture).nativeElement.getAttribute('aria-expanded')).toBe('true');
    });

    it('shows nav-item labels while open, unlike the plain icon rail', () => {
      openDrawer(fixture);

      const homeLink = fixture.debugElement
        .queryAll(By.css('nav a'))
        .find((el) => (el.nativeElement.textContent as string).includes('Home'));
      expect(homeLink?.nativeElement.querySelector('span')).toBeTruthy();
    });

    it('closes on backdrop click', () => {
      openDrawer(fixture);

      backdrop(fixture).nativeElement.click();
      fixture.detectChanges();

      expect(aside(fixture).nativeElement.hasAttribute('inert')).toBeTrue();
      expect(backdrop(fixture)).toBeNull();
    });

    it('closes on Escape and restores focus to the hamburger trigger', () => {
      openDrawer(fixture);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      fixture.detectChanges();

      expect(aside(fixture).nativeElement.hasAttribute('inert')).toBeTrue();
      expect(document.activeElement).toBe(drawerTrigger(fixture).nativeElement);
    });

    it('closes when a nav link is clicked', () => {
      openDrawer(fixture);

      const homeLink = fixture.debugElement
        .queryAll(By.css('nav a'))
        .find((el) => (el.nativeElement.textContent as string).includes('Home'));
      homeLink?.nativeElement.click();
      fixture.detectChanges();

      expect(aside(fixture).nativeElement.hasAttribute('inert')).toBeTrue();
    });
  });

  // --- Quick-create top bar (docs/specs/14 slice 3a) ---

  describe('quick actions', () => {
    beforeEach(async () => {
      localStorage.clear();
      ({ fixture, authApi } = await setup(false));
      authStore = TestBed.inject(AuthStore);
      authStore.setSession(
        'a',
        'r',
        makeUser({ permissions: ['client-admin:access', 'network.manage'] }),
      );
    });

    function quickActionTrigger() {
      return fixture.debugElement
        .queryAll(By.css('button'))
        .find(
          (el) =>
            (el.nativeElement as HTMLElement).getAttribute('aria-label') ===
            'Create a new record',
        );
    }

    function openQuickActions(): HTMLButtonElement[] {
      (quickActionTrigger()!.nativeElement as HTMLButtonElement).click();
      fixture.detectChanges();
      return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    }

    it('renders no top bar at all when an app supplies no actions', () => {
      // super-admin-app and validator-app pass none, so their layout is
      // unchanged by this addition.
      fixture.detectChanges();
      expect(quickActionTrigger()).toBeUndefined();
    });

    it('renders the trigger once an app supplies actions', () => {
      fixture.componentInstance.quickActions = [
        { label: 'New route', path: '/routes/new', permissions: ['network.manage'] },
      ];
      fixture.detectChanges();
      expect(quickActionTrigger()).toBeDefined();
    });

    it('offers only the actions the user may perform', () => {
      // Gated the same way nav items are — offering a create a user
      // cannot perform is worse than omitting it.
      fixture.componentInstance.quickActions = [
        { label: 'New route', path: '/routes/new', permissions: ['network.manage'] },
        { label: 'New vehicle', path: '/vehicles/new', permissions: ['fleet.manage'] },
        { label: 'New anything', path: '/anything/new', permissions: [] },
      ];
      fixture.detectChanges();

      expect(openQuickActions().map((el) => el.textContent?.trim())).toEqual([
        'New route',
        'New anything',
      ]);
    });

    it('hides the whole bar when the user may perform none of them', () => {
      fixture.componentInstance.quickActions = [
        { label: 'New vehicle', path: '/vehicles/new', permissions: ['fleet.manage'] },
      ];
      fixture.detectChanges();
      expect(quickActionTrigger()).toBeUndefined();
    });

    it('navigates to the chosen path', async () => {
      const router = TestBed.inject(Router);
      const navigate = spyOn(router, 'navigate').and.resolveTo(true);
      fixture.componentInstance.quickActions = [
        { label: 'New route', path: '/routes/new', permissions: ['network.manage'] },
      ];
      fixture.detectChanges();

      openQuickActions()[0].click();
      // ui-action-menu defers its emission by a macrotask so the menu has
      // closed and returned focus first.
      await new Promise((resolve) => setTimeout(resolve));

      expect(navigate).toHaveBeenCalledWith(['/routes/new']);
    });
  });
});
