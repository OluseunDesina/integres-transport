import { Injectable, computed, inject } from '@angular/core';

import { AuthStore } from './auth-store';

/**
 * Sourced directly from `/me`'s `permissions` array (Slice 4) — real
 * per-permission RBAC (Role/Permission/StaffInvitation), not Phase 0's
 * synthetic derivation from the three boolean flags on `Me`. Deliberate
 * behavior change, not a silent regression: a client-staff user's set
 * still always includes `client-admin:access` (the backend's
 * `MeSerializer.get_permissions` prepends it), so every existing
 * `*appHasPermission="'client-admin:access'"` check keeps working
 * unchanged — the set just also carries real codenames now
 * (`business.manage`, `staff.invite`, ...).
 */
@Injectable({ providedIn: 'root' })
export class PermissionsService {
  private readonly authStore = inject(AuthStore);

  readonly permissions = computed<ReadonlySet<string>>(() => {
    const user = this.authStore.user();
    return user ? new Set(user.permissions) : new Set();
  });

  has(permission: string): boolean {
    return this.permissions().has(permission);
  }

  hasAny(permissions: readonly string[]): boolean {
    return permissions.some((p) => this.has(p));
  }
}
