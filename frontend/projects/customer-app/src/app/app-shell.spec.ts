import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthApiService } from '@auth';

import { AppShell } from './app-shell';

describe('AppShell', () => {
  let fixture: ComponentFixture<AppShell>;
  let component: AppShell;

  beforeEach(async () => {
    const authApiSpy = jasmine.createSpyObj<AuthApiService>('AuthApiService', ['login', 'logout']);

    await TestBed.configureTestingModule({
      imports: [AppShell],
      providers: [provideRouter([]), { provide: AuthApiService, useValue: authApiSpy }],
    }).compileComponents();

    fixture = TestBed.createComponent(AppShell);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates', () => {
    expect(component).toBeTruthy();
  });

  it('links to all passenger destinations', () => {
    const links = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>('nav a')
    );
    expect(links.map((a) => a.textContent?.trim())).toEqual([
      'Search trips',
      'My bookings',
      'Tap & Go',
    ]);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/search',
      '/my-bookings',
      '/credentials',
    ]);
  });

  it('calls authApi.logout() and navigates to /login on sign out', async () => {
    const authApi = TestBed.inject(AuthApiService) as jasmine.SpyObj<AuthApiService>;
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

    await component['signOut']();

    expect(authApi.logout).toHaveBeenCalled();
    expect(navigateSpy).toHaveBeenCalledWith(['/login']);
  });
});
