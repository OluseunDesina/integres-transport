import { BreakpointObserver } from '@angular/cdk/layout';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthApiService } from '@auth';
import { of } from 'rxjs';

import { AppShell } from './app-shell';
import { SeniorModeStore } from './shared/data/store/senior-mode.store';

// A fake BreakpointObserver defaulting to "wide" (matches: false) so
// every existing assertion keeps meaning what it already meant,
// independent of whatever width Karma's actual browser window happens
// to be — matches NavShell's own spec (projects/layout).
function fakeBreakpointObserver(matches: boolean): Partial<BreakpointObserver> {
  return { observe: () => of({ matches, breakpoints: {} }) };
}

async function setup(matches = false): Promise<ComponentFixture<AppShell>> {
  const authApiSpy = jasmine.createSpyObj<AuthApiService>('AuthApiService', ['login', 'logout']);
  // AppShell always renders NotificationBell, which fetches on init —
  // a resolved-empty GET keeps every existing assertion here meaning
  // what it already meant.
  const apiClient = {
    GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
    POST: jasmine.createSpy('POST'),
  };

  await TestBed.configureTestingModule({
    imports: [AppShell],
    providers: [
      provideRouter([{ path: 'my-bookings', children: [] }]),
      { provide: AuthApiService, useValue: authApiSpy },
      { provide: API_CLIENT, useValue: apiClient },
      { provide: BreakpointObserver, useValue: fakeBreakpointObserver(matches) },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(AppShell);
  fixture.detectChanges();
  return fixture;
}

const expectedLabels = [
  'Search',
  'Bookings',
  'Tap & Go',
  'Journeys',
  'Payments',
  'Wallet',
  // Spec 17 slice 3. One link, not two: "Report an issue" is a button
  // on this screen and a row action in my-bookings, because the
  // destination is the record and reporting is the action.
  'Reports',
];
const expectedHrefs = [
  '/search',
  '/my-bookings',
  '/credentials',
  '/journeys',
  '/payments',
  '/wallet',
  '/my-reports',
];

describe('AppShell', () => {
  // SeniorModeStore is `providedIn: 'root'` and reads/writes real
  // localStorage — without this, a persisted `true` from one test's
  // store.set(true) would leak into the next test's "defaults to off"
  // assumption.
  beforeEach(() => localStorage.removeItem('integra.senior-mode'));
  afterEach(() => {
    localStorage.removeItem('integra.senior-mode');
    document.documentElement.removeAttribute('data-senior');
  });

  it('creates', async () => {
    const fixture = await setup();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders the top-bar nav, not the tab bar, at desktop width', async () => {
    const fixture = await setup(false);
    const el = fixture.nativeElement as HTMLElement;
    const navs = el.querySelectorAll('nav[aria-label="Primary"]');
    expect(navs.length).toBe(1);

    const links = Array.from(navs[0].querySelectorAll<HTMLAnchorElement>('a'));
    expect(links.map((a) => a.textContent?.trim())).toEqual(expectedLabels);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(expectedHrefs);

    // The fixed bottom bar must not exist at all at this width, not
    // merely be hidden — a duplicated nav[aria-label="Primary"]
    // landmark is announced twice regardless of `display`.
    expect(el.querySelector('.fixed.bottom-0')).toBeNull();
  });

  it('switches to the bottom tab bar below the sm breakpoint, keeping exactly one nav landmark', async () => {
    const fixture = await setup(true);
    const el = fixture.nativeElement as HTMLElement;
    const navs = el.querySelectorAll('nav[aria-label="Primary"]');
    expect(navs.length).toBe(1);

    const bar = el.querySelector('.fixed.bottom-0');
    expect(bar).not.toBeNull();
    expect(bar?.contains(navs[0])).toBe(true);

    const links = Array.from(navs[0].querySelectorAll<HTMLAnchorElement>('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(expectedHrefs);
    // Every tab carries an icon — the label alone is too narrow a
    // column to read reliably at 320-390px.
    expect(links.every((a) => a.querySelector('ui-icon'))).toBe(true);
  });

  it('marks the active link with aria-current in both layouts', async () => {
    const wide = await setup(false);
    await TestBed.inject(Router).navigateByUrl('/my-bookings');
    wide.detectChanges();
    expect(
      (wide.nativeElement as HTMLElement)
        .querySelector('a[href="/my-bookings"]')
        ?.getAttribute('aria-current')
    ).toBe('page');

    TestBed.resetTestingModule();
    const narrow = await setup(true);
    await TestBed.inject(Router).navigateByUrl('/my-bookings');
    narrow.detectChanges();
    expect(
      (narrow.nativeElement as HTMLElement)
        .querySelector('a[href="/my-bookings"]')
        ?.getAttribute('aria-current')
    ).toBe('page');
  });

  it('calls authApi.logout() and navigates to /login on sign out', async () => {
    const fixture = await setup();
    const authApi = TestBed.inject(AuthApiService) as jasmine.SpyObj<AuthApiService>;
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

    await fixture.componentInstance['signOut']();

    expect(authApi.logout).toHaveBeenCalled();
    expect(navigateSpy).toHaveBeenCalledWith(['/login']);
  });

  // Spec 21 slice 3. Both widths, since the spec requires the toggle
  // reachable "at every viewport" — the top-bar nav disappears below
  // `sm`, and this must not.
  for (const [name, mobile] of [
    ['desktop', false],
    ['mobile', true],
  ] as const) {
    it(`renders the Senior Mode toggle at ${name} width, wired to SeniorModeStore`, async () => {
      const fixture = await setup(mobile);
      const el = fixture.nativeElement as HTMLElement;

      const toggle = el.querySelector('ui-toggle');
      expect(toggle).not.toBeNull();

      const button = toggle?.querySelector('button[role="switch"]');
      expect(button?.getAttribute('aria-label')).toBe('Senior mode');
      expect(button?.getAttribute('aria-describedby')).toBe('senior-mode-hint');
      expect(el.querySelector('#senior-mode-hint')?.textContent?.trim()).toContain(
        'Larger text'
      );
      expect(button?.getAttribute('aria-checked')).toBe('false');

      const store = TestBed.inject(SeniorModeStore);
      store.set(true);
      fixture.detectChanges();

      expect(
        (el.querySelector('ui-toggle button[role="switch"]') as HTMLElement | null)?.getAttribute(
          'aria-checked'
        )
      ).toBe('true');
    });
  }

  it('clicking the Senior Mode toggle flips SeniorModeStore', async () => {
    const fixture = await setup();
    const store = TestBed.inject(SeniorModeStore);
    expect(store.enabled()).toBeFalse();

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('ui-toggle button[role="switch"]')
      ?.click();
    fixture.detectChanges();

    expect(store.enabled()).toBeTrue();
  });
});
