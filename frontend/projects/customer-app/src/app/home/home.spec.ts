import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { Home } from './home';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    email: 'passenger@example.com',
    firstName: '',
    lastName: '',
    client: 'client-1',
    isPlatformStaff: false,
    isClientStaff: false,
    permissions: ['customer:access'],
    roleName: null,
    clientName: null,
    ...overrides,
  };
}

describe('Home', () => {
  let fixture: ComponentFixture<Home>;
  let component: Home;

  beforeEach(async () => {
    // AuthStore persists to localStorage, so a session left by an
    // earlier spec would decide this one's greeting.
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [Home],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(Home);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('creates', () => {
    expect(component).toBeTruthy();
  });

  it('shows a placeholder when no user is signed in', () => {
    const heading = fixture.nativeElement.querySelector('h1') as HTMLElement;
    expect(heading.textContent).toContain('Welcome,');
  });

  // The old heading was "Welcome, {{ email }}" — a login credential in
  // the largest type on the passenger's home screen. `firstName` has
  // been on `AuthUser` since Phase 1 and nothing read it.
  it('greets by first name when the account has one', () => {
    TestBed.inject(AuthStore).setSession('a', 'r', makeUser({ firstName: 'Ada' }));
    fixture.detectChanges();

    const heading = fixture.nativeElement.querySelector('h1') as HTMLElement;
    expect(heading.textContent).toContain('Welcome back, Ada');
    expect(heading.textContent).not.toContain('@');
  });

  it('falls back to the email when the account has no first name', () => {
    TestBed.inject(AuthStore).setSession('a', 'r', makeUser());
    fixture.detectChanges();

    const heading = fixture.nativeElement.querySelector('h1') as HTMLElement;
    expect(heading.textContent).toContain('passenger@example.com');
  });

  it('offers the account destinations as links, not just nav items', () => {
    const links = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>('a')
    );

    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/my-bookings',
      '/credentials',
      '/wallet',
      '/activity',
    ]);
  });

  // Sign out moved to AppShell when home became a child route under it
  // (spec §4.1) — home no longer owns a second, duplicate control.
  it('sends the passenger to the search screen', async () => {
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

    await component['goToSearch']();

    expect(navigateSpy).toHaveBeenCalledWith(['/search']);
  });
});
