import { TestBed } from '@angular/core/testing';

import { AuthStore } from './auth-store';
import type { AuthUser } from './auth-user';
import { PermissionsService } from './permissions.service';

function makeUser(overrides: Partial<AuthUser>): AuthUser {
  return {
    id: 'user-1',
    email: 'user@example.com',
    firstName: '',
    lastName: '',
    client: null,
    isPlatformStaff: false,
    isClientStaff: false,
    permissions: [],
    roleName: null,
    clientName: null,
    ...overrides,
  };
}

describe('PermissionsService', () => {
  let service: PermissionsService;
  let authStore: AuthStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    service = TestBed.inject(PermissionsService);
    authStore = TestBed.inject(AuthStore);
  });

  afterEach(() => localStorage.clear());

  it('grants no permissions when signed out', () => {
    expect(service.permissions().size).toBe(0);
    expect(service.has('customer:access')).toBeFalse();
  });

  it('grants exactly the permissions /me returned, to an ordinary passenger', () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({ client: 'client-1', permissions: ['customer:access'] })
    );
    expect(service.has('customer:access')).toBeTrue();
    expect(service.has('client-admin:access')).toBeFalse();
  });

  it('grants client-admin:access plus real role codenames to client staff', () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({
        client: 'client-1',
        isClientStaff: true,
        permissions: ['client-admin:access', 'client.view', 'business.manage'],
      })
    );
    expect(service.has('client-admin:access')).toBeTrue();
    expect(service.has('business.manage')).toBeTrue();
    expect(service.has('customer:access')).toBeFalse();
  });

  it('grants only client-admin:access to a client-staff user with no role', () => {
    // MeSerializer still returns the base access string even when
    // role_id is null — see apps.identity.serializers.MeSerializer.
    authStore.setSession(
      'a',
      'r',
      makeUser({ client: 'client-1', isClientStaff: true, permissions: ['client-admin:access'] })
    );
    expect(service.has('client-admin:access')).toBeTrue();
    expect(service.has('business.manage')).toBeFalse();
  });

  it('grants super-admin:access to platform staff', () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({ client: null, isPlatformStaff: true, permissions: ['super-admin:access'] })
    );
    expect(service.has('super-admin:access')).toBeTrue();
  });

  it('hasAny() matches if any of the given permissions is granted', () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({ client: 'client-1', permissions: ['customer:access'] })
    );
    expect(service.hasAny(['client-admin:access', 'customer:access'])).toBeTrue();
    expect(service.hasAny(['super-admin:access'])).toBeFalse();
  });
});
