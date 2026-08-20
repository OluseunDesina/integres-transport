import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { AUTH_AUDIENCE } from './auth-audience.token';
import { AuthApiService } from './auth-api.service';
import { AuthStore } from './auth-store';

describe('AuthApiService', () => {
  let apiClient: { POST: jasmine.Spy; GET: jasmine.Spy };
  let service: AuthApiService;
  let authStore: AuthStore;

  beforeEach(() => {
    localStorage.clear();
    apiClient = {
      POST: jasmine.createSpy('POST'),
      GET: jasmine.createSpy('GET'),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: API_CLIENT, useValue: apiClient },
        { provide: AUTH_AUDIENCE, useValue: 'customer' },
      ],
    });

    service = TestBed.inject(AuthApiService);
    authStore = TestBed.inject(AuthStore);
  });

  afterEach(() => localStorage.clear());

  it('calls the customer token endpoint and stores the session on success', async () => {
    apiClient.POST.and.resolveTo({ data: { access: 'access-1', refresh: 'refresh-1' } });
    apiClient.GET.and.resolveTo({
      data: {
        id: 'user-1',
        email: 'passenger@example.com',
        first_name: 'Ada',
        last_name: 'Lovelace',
        client: 'client-1',
        is_platform_staff: false,
        is_client_staff: false,
        permissions: ['customer:access'],
      },
    });

    const result = await service.login('passenger@example.com', 'secret');

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/auth/customer/token/',
      jasmine.objectContaining({
        body: { email: 'passenger@example.com', password: 'secret', client: undefined },
      })
    );
    expect(result).toEqual({ ok: true });
    expect(authStore.isAuthenticated()).toBeTrue();
    expect(authStore.user()?.email).toBe('passenger@example.com');
    expect(authStore.user()?.permissions).toEqual(['customer:access']);
  });

  it('returns a failure result with the server message when the request errors', async () => {
    apiClient.POST.and.resolveTo({
      error: { detail: 'No active account found with the given credentials.' },
    });

    const result = await service.login('passenger@example.com', 'wrong');

    expect(result).toEqual({
      ok: false,
      message: 'No active account found with the given credentials.',
    });
    expect(authStore.isAuthenticated()).toBeFalse();
  });

  it('acceptClientInvitation() completes the invitation and stores the session on success', async () => {
    apiClient.POST.and.resolveTo({ data: { access: 'access-1', refresh: 'refresh-1' } });
    apiClient.GET.and.resolveTo({
      data: {
        id: 'user-1',
        email: 'owner@acme.example.com',
        first_name: 'Ada',
        last_name: 'Lovelace',
        client: 'client-1',
        is_platform_staff: false,
        is_client_staff: true,
        permissions: ['client-admin:access'],
      },
    });

    const result = await service.acceptClientInvitation('tok-1', '+2348012345678', 'secret');

    expect(apiClient.POST).toHaveBeenCalledWith('/api/v1/client-invitations/{token}/complete/', {
      params: { path: { token: 'tok-1' } },
      body: { phone: '+2348012345678', password: 'secret' },
    });
    expect(result).toEqual({ ok: true });
    expect(authStore.isAuthenticated()).toBeTrue();
  });

  it('acceptStaffInvitation() accepts the invitation and stores the session on success', async () => {
    apiClient.POST.and.resolveTo({ data: { access: 'access-1', refresh: 'refresh-1' } });
    apiClient.GET.and.resolveTo({
      data: {
        id: 'user-1',
        email: 'staff@acme.example.com',
        first_name: 'Ada',
        last_name: 'Lovelace',
        client: 'client-1',
        is_platform_staff: false,
        is_client_staff: true,
        permissions: ['client-admin:access'],
      },
    });

    const result = await service.acceptStaffInvitation('tok-1', 'secret');

    expect(apiClient.POST).toHaveBeenCalledWith('/api/v1/staff/invitations/{token}/accept/', {
      params: { path: { token: 'tok-1' } },
      body: { password: 'secret' },
    });
    expect(result).toEqual({ ok: true });
    expect(authStore.isAuthenticated()).toBeTrue();
  });

  it('logout() clears the session', () => {
    spyOn(authStore, 'clear');

    service.logout();

    expect(authStore.clear).toHaveBeenCalled();
  });
});
