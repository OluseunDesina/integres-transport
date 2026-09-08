import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Router } from '@angular/router';
import { AuthApiService, WhiteLabelResolverService } from '@auth';

import { Login } from './login';

describe('Login', () => {
  let fixture: ComponentFixture<Login>;
  let component: Login;
  let authApi: jasmine.SpyObj<AuthApiService>;

  beforeEach(async () => {
    authApi = jasmine.createSpyObj<AuthApiService>('AuthApiService', ['login', 'logout']);

    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [
        provideRouter([]),
        { provide: AuthApiService, useValue: authApi },
        {
          provide: WhiteLabelResolverService,
          // `branding` too since slice 5: the brand mark on this screen
          // is the first consumer of the logo/name half of the
          // white-label response.
          useValue: { clientId: () => null, branding: () => null },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Login);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates', () => {
    expect(component).toBeTruthy();
  });

  it('does not submit an invalid form', async () => {
    await component['onSubmit']();
    expect(authApi.login).not.toHaveBeenCalled();
  });

  it('shows the server error message when login fails', async () => {
    authApi.login.and.resolveTo({ ok: false, message: 'No active account found with the given credentials.' });
    component['form'].setValue({ email: 'passenger@example.com', password: 'wrong' });

    await component['onSubmit']();

    expect(component['errorMessage']()).toBe('No active account found with the given credentials.');
  });

  it('navigates to /home on successful login', async () => {
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);
    authApi.login.and.resolveTo({ ok: true });
    component['form'].setValue({ email: 'passenger@example.com', password: 'correct-horse' });

    await component['onSubmit']();

    expect(navigateSpy).toHaveBeenCalledWith(['/home']);
  });
});
