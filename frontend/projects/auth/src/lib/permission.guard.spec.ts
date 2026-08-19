import type { ActivatedRouteSnapshot, RouterStateSnapshot, UrlTree } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { AuthStore } from './auth-store';
import type { AuthUser } from './auth-user';
import { permissionGuard } from './permission.guard';

const user: AuthUser = {
  id: 'user-1',
  email: 'staff@example.com',
  firstName: '',
  lastName: '',
  client: 'client-1',
  isPlatformStaff: false,
  isClientStaff: true,
  permissions: ['client-admin:access'],
  roleName: null,
  clientName: null,
};

function routeWithPermissions(permissions: string[]): ActivatedRouteSnapshot {
  return { data: { permissions } } as unknown as ActivatedRouteSnapshot;
}

describe('permissionGuard', () => {
  let authStore: AuthStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    authStore = TestBed.inject(AuthStore);
  });

  afterEach(() => localStorage.clear());

  function runGuard(route: ActivatedRouteSnapshot): boolean | UrlTree {
    return TestBed.runInInjectionContext(() =>
      permissionGuard(route, {} as RouterStateSnapshot)
    ) as boolean | UrlTree;
  }

  it('redirects to /login when not authenticated', () => {
    const result = runGuard(routeWithPermissions(['client-admin:access']));
    const router = TestBed.inject(Router);

    expect(result).toEqual(router.createUrlTree(['/login']));
  });

  it('allows access when the user has a required permission', () => {
    authStore.setSession('a', 'r', user);

    const result = runGuard(routeWithPermissions(['client-admin:access']));

    expect(result).toBeTrue();
  });

  it('redirects to /forbidden when authenticated but lacking the permission', () => {
    authStore.setSession('a', 'r', user);
    const router = TestBed.inject(Router);

    const result = runGuard(routeWithPermissions(['super-admin:access']));

    expect(result).toEqual(router.createUrlTree(['/forbidden']));
  });

  it('allows access when the route declares no required permissions', () => {
    authStore.setSession('a', 'r', user);

    const result = runGuard(routeWithPermissions([]));

    expect(result).toBeTrue();
  });
});
