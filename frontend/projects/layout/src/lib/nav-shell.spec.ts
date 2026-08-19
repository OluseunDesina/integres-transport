import { BreakpointObserver } from '@angular/cdk/layout';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
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

  await TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [
      provideRouter([{ path: 'home', children: [] }]),
      { provide: AuthApiService, useValue: authApi },
      { provide: BreakpointObserver, useValue: fakeBreakpointObserver(matches) },
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

function openProfileMenu(fixture: ComponentFixture<HostComponent>): void {
  const trigger = fixture.debugElement.query(By.css('[aria-haspopup="menu"]'));
  trigger.nativeElement.click();
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
        const trigger = fixture.debugElement.query(By.css('[aria-haspopup="menu"]'));
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
        const trigger = fixture.debugElement.query(By.css('[aria-haspopup="menu"]'));
        expect(document.activeElement).toBe(trigger.nativeElement);
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
      const trigger = fixture.debugElement.query(By.css('[aria-haspopup="menu"]'));
      expect(trigger.nativeElement.getAttribute('aria-label')).toBe('owner@example.com');

      openProfileMenu(fixture);

      expect(findButtonByText(fixture, 'Sign out')).toBeTruthy();
    });
  });
});
