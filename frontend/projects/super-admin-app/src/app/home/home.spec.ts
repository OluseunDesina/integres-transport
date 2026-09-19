import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { Home } from './home';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    email: 'staff@integra.example',
    firstName: '',
    lastName: '',
    client: null,
    isPlatformStaff: true,
    isClientStaff: false,
    permissions: ['super-admin:access'],
    roleName: null,
    clientName: null,
    ...overrides,
  };
}

describe('Home', () => {
  let fixture: ComponentFixture<Home>;
  let component: Home;

  beforeEach(async () => {
    // AuthStore persists to localStorage, so a session left by another
    // spec would decide this one's greeting.
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

  it('greets by first name when the account has one', () => {
    TestBed.inject(AuthStore).setSession('a', 'r', makeUser({ firstName: 'Ada' }));
    fixture.detectChanges();

    expect((fixture.nativeElement.querySelector('h1') as HTMLElement).textContent).toContain(
      'Welcome back, Ada'
    );
  });

  /**
   * This screen was the Phase 0 placeholder until spec 14 slice 6a: it
   * printed `Client: —`, `Platform staff: true` and a green box reading
   * "You have super-admin-app access." — diagnostic output on the
   * landing page platform staff see every day, telling a platform-staff
   * user that they are platform staff.
   */
  it('does not print raw account diagnostics', () => {
    TestBed.inject(AuthStore).setSession('a', 'r', makeUser());
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Platform staff');
    expect(text).not.toContain('super-admin-app access');
    expect(text).not.toContain('true');
  });

  it('links to every destination the nav carries', () => {
    const links = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>('a')
    );

    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/kyc-queue',
      '/businesses',
      '/invite-client',
    ]);
  });
});
