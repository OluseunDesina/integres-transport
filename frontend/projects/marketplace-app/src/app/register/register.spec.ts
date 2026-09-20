import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthApiService, WhiteLabelResolverService } from '@auth';

import { Register } from './register';

describe('Register', () => {
  let fixture: ComponentFixture<Register>;
  let component: Register;
  let authApi: jasmine.SpyObj<AuthApiService>;

  beforeEach(async () => {
    authApi = jasmine.createSpyObj<AuthApiService>('AuthApiService', ['registerCustomer']);

    await TestBed.configureTestingModule({
      imports: [Register],
      providers: [
        provideRouter([]),
        { provide: AuthApiService, useValue: authApi },
        // `app-brand-mark` (inside `app-auth-layout`) injects this
        // internally even though `Register` itself never does.
        { provide: WhiteLabelResolverService, useValue: { clientId: () => null, branding: () => null } },
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
    expect(authApi.registerCustomer).not.toHaveBeenCalled();
  });

  it('shows the server error message when registration fails', async () => {
    authApi.registerCustomer.and.resolveTo({
      ok: false,
      message: 'An account with this email already exists.',
    });
    component['form'].setValue({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'passenger@example.com',
      password: 'weak',
    });

    await component['onSubmit']();

    expect(component['errorMessage']()).toBe('An account with this email already exists.');
  });

  it('registers with the form fields and navigates to /search on success', async () => {
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);
    authApi.registerCustomer.and.resolveTo({ ok: true });
    component['form'].setValue({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'passenger@example.com',
      password: 'a-strong-unguessable-passphrase-42',
    });

    await component['onSubmit']();

    expect(authApi.registerCustomer).toHaveBeenCalledWith(
      'passenger@example.com',
      'a-strong-unguessable-passphrase-42',
      'Ada',
      'Lovelace'
    );
    expect(navigateSpy).toHaveBeenCalledWith(['/search']);
  });

  it('forwards a pending booking to /book instead of /search once registered', async () => {
    const pendingBooking = {
      tripId: 'trip-1',
      routeName: 'Yaba to Ikeja',
      serviceDate: '2026-10-01',
      scheduledDepartureAt: '2026-10-01T08:00:00Z',
      fromStop: { id: 'stop-a', name: 'Yaba' },
      toStop: { id: 'stop-b', name: 'Ikeja' },
      farePerSeat: '750.00',
      currency: 'NGN',
      passengerCount: 1,
      seatSelectionEnabled: true,
      travelers: [
        {
          title: '',
          firstName: 'Ada',
          lastName: 'Lovelace',
          phone: '+2348000000000',
          email: 'ada@example.com',
          dateOfBirth: '',
          gender: '',
          nationality: '',
        },
      ],
    };
    // `replaceState`, not `pushState`/`back()` — see login.spec.ts's
    // identical test for why.
    const originalState: unknown = history.state;
    history.replaceState({ pendingBooking }, '');
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);
    authApi.registerCustomer.and.resolveTo({ ok: true });
    component['form'].setValue({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'passenger@example.com',
      password: 'a-strong-unguessable-passphrase-42',
    });

    try {
      await component['onSubmit']();
    } finally {
      history.replaceState(originalState, '');
    }

    expect(navigateSpy).toHaveBeenCalledWith(['/book'], { state: pendingBooking });
  });
});
