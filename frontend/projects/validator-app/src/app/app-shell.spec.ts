import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthApiService, AuthStore } from '@auth';

import { AppShell } from './app-shell';

describe('AppShell', () => {
  let fixture: ComponentFixture<AppShell>;
  let authApi: jasmine.SpyObj<AuthApiService>;

  async function createShell(permissions: string[] = []): Promise<void> {
    authApi = jasmine.createSpyObj<AuthApiService>('AuthApiService', ['login', 'logout']);
    // AppShell now always renders NotificationBell, which fetches on
    // init and needs both API_CLIENT and AuthStore.accessToken() —
    // a resolved-empty GET keeps every existing assertion here meaning
    // what it already meant.
    const apiClient = {
      GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
      POST: jasmine.createSpy('POST'),
    };

    await TestBed.configureTestingModule({
      imports: [AppShell],
      providers: [
        provideRouter([]),
        { provide: AuthApiService, useValue: authApi },
        {
          provide: AuthStore,
          useValue: {
            user: () => ({ email: 'staff@example.com', permissions }),
            isAuthenticated: () => true,
            accessToken: () => 'test-token',
          },
        },
        { provide: API_CLIENT, useValue: apiClient },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AppShell);
    fixture.detectChanges();
  }

  beforeEach(async () => {
    await createShell(['tapngo.record', 'ticketing.validate']);
  });

  it('creates', () => {
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('shows the signed-in user email', () => {
    expect(fixture.nativeElement.textContent).toContain('staff@example.com');
  });

  // `href`, not the `routerLink` attribute: the links are generated
  // from a list with a bound `[routerLink]`, which emits no static
  // attribute to read. Same assertion customer-app's own shell spec
  // makes.
  it('renders nav links to both tapping screens', () => {
    const links = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('nav a')
    ).map((a) => a.getAttribute('href'));
    // No /report-issue: this user holds the two tapping codenames but
    // not `incidents.manage`, which a custom Role can perfectly well
    // omit. The link is filtered rather than rendered and then 403'd by
    // its own guard.
    expect(links).toEqual(['/record', '/validate-ticket']);
  });

  it('adds the report link for a user who can file incidents', async () => {
    TestBed.resetTestingModule();
    await createShell(['tapngo.record', 'ticketing.validate', 'incidents.manage']);

    const links = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('nav a')
    ).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/record', '/validate-ticket', '/report-issue']);
  });

  it('signs out and navigates to /login', async () => {
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

    await fixture.componentInstance['signOut']();

    expect(authApi.logout).toHaveBeenCalled();
    expect(navigateSpy).toHaveBeenCalledWith(['/login']);
  });
});
