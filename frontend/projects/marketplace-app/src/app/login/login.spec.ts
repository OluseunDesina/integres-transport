import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
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
        // `app-brand-mark` (inside `app-auth-layout`) injects this
        // internally even though `Login` itself never does — stubbed
        // the same way customer-app's own login.spec.ts stubs it, to
        // avoid its real implementation's own API_CLIENT dependency.
        { provide: WhiteLabelResolverService, useValue: { clientId: () => null, branding: () => null } },
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
    authApi.login.and.resolveTo({
      ok: false,
      message: 'No active account found with the given credentials.',
    });
    component['form'].setValue({ email: 'passenger@example.com', password: 'wrong' });

    await component['onSubmit']();

    expect(component['errorMessage']()).toBe(
      'No active account found with the given credentials.'
    );
  });

  it('logs in with no client disambiguation and navigates to /search — this app has no white-label subdomain', async () => {
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);
    authApi.login.and.resolveTo({ ok: true });
    component['form'].setValue({ email: 'passenger@example.com', password: 'correct-horse' });

    await component['onSubmit']();

    expect(authApi.login).toHaveBeenCalledWith('passenger@example.com', 'correct-horse');
    expect(navigateSpy).toHaveBeenCalledWith(['/search']);
  });

  it('forwards a pending booking to /book instead of /search once signed in', async () => {
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
    // Simulates the router state a guest's "Book now" wrote before
    // redirecting here — `readPendingBooking()` falls back to
    // `history.state` outside of an active navigation, which is what a
    // later click on Login actually sees (see booking-draft.ts).
    // `replaceState`, not `pushState`/`back()`: it mutates the current
    // entry synchronously with no `popstate` involved, so there is
    // nothing async to race or leave behind for a later test.
    const originalState: unknown = history.state;
    history.replaceState({ pendingBooking }, '');
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);
    authApi.login.and.resolveTo({ ok: true });
    component['form'].setValue({ email: 'passenger@example.com', password: 'correct-horse' });

    try {
      await component['onSubmit']();
    } finally {
      history.replaceState(originalState, '');
    }

    expect(navigateSpy).toHaveBeenCalledWith(['/book'], { state: pendingBooking });
  });
});
