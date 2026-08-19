import { inject } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { Router } from '@angular/router';

import { AuthStore } from './auth-store';
import { PermissionsService } from './permissions.service';

/**
 * Route guard reading required permissions from `route.data['permissions']`
 * — the routing-layer half of the three-layer authorization pattern
 * (guard + nav filtering + `*appHasPermission` in templates).
 */
export const permissionGuard: CanActivateFn = (route) => {
  const authStore = inject(AuthStore);
  const permissionsService = inject(PermissionsService);
  const router = inject(Router);

  if (!authStore.isAuthenticated()) {
    return router.createUrlTree(['/login']);
  }

  const required = (route.data['permissions'] as string[] | undefined) ?? [];
  if (required.length === 0 || permissionsService.hasAny(required)) {
    return true;
  }

  return router.createUrlTree(['/forbidden']);
};
