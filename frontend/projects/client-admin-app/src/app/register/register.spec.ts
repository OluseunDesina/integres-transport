import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthApiService } from '@auth';

import { Register } from './register';

describe('Register', () => {
  let fixture: ComponentFixture<Register>;
  let component: Register;
  let authApi: jasmine.SpyObj<AuthApiService>;

  const validValues = {
    name: 'Acme Shuttle Co',
    email: 'owner@acme.example.com',
    phone: '+2348012345678',
    password: 'a-strong-unguessable-passphrase-42',
    confirmPassword: 'a-strong-unguessable-passphrase-42',
  };

  beforeEach(async () => {
    authApi = jasmine.createSpyObj<AuthApiService>('AuthApiService', ['register', 'login', 'logout']);

    await TestBed.configureTestingModule({
      imports: [Register],
      providers: [provideRouter([]), { provide: AuthApiService, useValue: authApi }],
    }).compileComponents();

    fixture = TestBed.createComponent(Register);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates', () => {
    expect(component).toBeTruthy();
  });

  it('does not submit an invalid form', async () => {
    await component['onSubmit']();
    expect(authApi.register).not.toHaveBeenCalled();
  });

  it('rejects a form where the passwords do not match', async () => {
    component['form'].setValue({ ...validValues, confirmPassword: 'something-else' });

    await component['onSubmit']();

    expect(authApi.register).not.toHaveBeenCalled();
    expect(component['fieldError']('confirmPassword')).toBe('Passwords do not match.');
  });

  it('shows the server error message when registration fails', async () => {
    authApi.register.and.resolveTo({
      ok: false,
      message: 'A client with this email already exists.',
    });
    component['form'].setValue(validValues);

    await component['onSubmit']();

    expect(component['errorMessage']()).toBe('A client with this email already exists.');
  });

  it('navigates to /home on successful registration', async () => {
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);
    authApi.register.and.resolveTo({ ok: true });
    component['form'].setValue(validValues);

    await component['onSubmit']();

    expect(authApi.register).toHaveBeenCalledWith(
      validValues.name,
      validValues.email,
      validValues.phone,
      validValues.password
    );
    expect(navigateSpy).toHaveBeenCalledWith(['/home']);
  });
});
