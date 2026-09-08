import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
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
      providers: [
        provideRouter([]),
        { provide: AuthApiService, useValue: authApi },
        // The brand mark this screen renders resolves white-label
        // through `WhiteLabelResolverService`, which injects API_CLIENT.
        { provide: API_CLIENT, useValue: { GET: jasmine.createSpy('GET').and.resolveTo({}) } },
      ],
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
    // Rendered, not merely computed. `passwordMismatch` is a *form*-level
    // error and `fieldErrorMessage` reads control-level errors only, so
    // this is the one message the slice 6b migration could have dropped
    // silently — and ui-text-field shows nothing unless the parent binds
    // both `invalid` and `errorMessage`.
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Passwords do not match.');
  });

  it('names the field that is missing, not just that something is', async () => {
    component['form'].controls.email.markAsTouched();
    fixture.detectChanges();

    expect(component['fieldError']('email')).toBe('Email is required.');
    expect(fixture.nativeElement.textContent).toContain('Email is required.');
  });

  it('reports a malformed email as malformed rather than missing', async () => {
    component['form'].controls.email.setValue('not-an-email');
    component['form'].controls.email.markAsTouched();
    fixture.detectChanges();

    expect(component['fieldError']('email')).toBe('Enter a valid email address.');
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
