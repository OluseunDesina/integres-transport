export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  client: string | null;
  isPlatformStaff: boolean;
  isClientStaff: boolean;
  /** Sourced from `/me`'s `permissions` array (Slice 4) — real
   * per-permission RBAC, not the Phase 0 synthetic derivation. */
  permissions: string[];
  /** "Owner" | "Manager" | "Staff" — null for passengers and platform
   * staff (neither has a `role` FK). Sourced from `/me`'s `role_name`. */
  roleName: string | null;
  /** The Client's own (tenant/org) name — distinct from any Business
   * name. Null for passengers/platform staff (no `client`). Sourced
   * from `/me`'s `client_name`. */
  clientName: string | null;
}

export type AuthAudience = 'customer' | 'client-admin' | 'super-admin';
