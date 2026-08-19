import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthApiService, AuthStore } from '@auth';

import { AppShell } from './app-shell';

describe('AppShell', () => {
  let fixture: ComponentFixture<AppShell>;
  let authApi: jasmine.SpyObj<AuthApiService>;

  beforeEach(async () => {
    authApi = jasmine.createSpyObj<AuthApiService>('AuthApiService', ['login', 'logout']);

    await TestBed.configureTestingModule({
      imports: [AppShell],
      providers: [
        provideRouter([]),
        { provide: AuthApiService, useValue: authApi },
        {
          provide: AuthStore,
          useValue: { user: () => ({ email: 'staff@example.com' }), isAuthenticated: () => true },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AppShell);
    fixture.detectChanges();
  });

  it('creates', () => {
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('shows the signed-in user email', () => {
    expect(fixture.nativeElement.textContent).toContain('staff@example.com');
  });

  it('renders nav links to both screens', () => {
    const links = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('nav a')
    ).map((a) => a.getAttribute('routerLink'));
    expect(links).toEqual(['/record', '/validate-ticket']);
  });

  it('signs out and navigates to /login', async () => {
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

    await fixture.componentInstance['signOut']();

    expect(authApi.logout).toHaveBeenCalled();
    expect(navigateSpy).toHaveBeenCalledWith(['/login']);
  });
});
