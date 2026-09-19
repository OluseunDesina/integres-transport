import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';

import { AUTH_AUDIENCE } from './auth-audience.token';
import { AuthStore } from './auth-store';
import type { AuthUser } from './auth-user';

export type LoginResult = { ok: true } | { ok: false; message: string };

/** DRF's normal validation-error shape is a per-field dict of message
 * arrays (`{"email": ["..."]}`), not the flat `{detail}` shape the login
 * serializers deliberately collapse to — this isn't declared in the
 * OpenAPI schema (drf-spectacular only documents the 2xx response), so
 * it's handled generically rather than typed precisely. */
function extractFirstErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    for (const value of Object.values(error as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0];
      }
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return 'Registration failed. Check your details and try again.';
}

@Injectable({ providedIn: 'root' })
export class AuthApiService {
  private readonly api = inject(API_CLIENT);
  private readonly audience = inject(AUTH_AUDIENCE);
  private readonly authStore = inject(AuthStore);

  async register(name: string, email: string, phone: string, password: string): Promise<LoginResult> {
    const { data, error } = await this.api.POST('/api/v1/clients/register/', {
      body: { name, email, phone, password },
    });
    if (!data) {
      return { ok: false, message: extractFirstErrorMessage(error) };
    }

    const user = await this.fetchCurrentUser(data.access);
    if (!user) {
      return { ok: false, message: 'Registered, but could not load your account. Try again.' };
    }

    this.authStore.setSession(data.access, data.refresh, user);
    return { ok: true };
  }

  /**
   * Passenger self-registration (docs/specs/22-marketplace.md) — under
   * the platform's singleton Marketplace Client, always audience
   * `customer`. First consumer is `marketplace-app`; lives here rather
   * than app-local since it's a genuinely new *auth* capability, not a
   * marketplace-specific one, matching this file's existing shape for
   * every other registration/invitation-acceptance flow.
   */
  async registerCustomer(
    email: string,
    password: string,
    firstName: string,
    lastName: string
  ): Promise<LoginResult> {
    const { data, error } = await this.api.POST('/api/v1/auth/customer/register/', {
      body: { email, password, first_name: firstName, last_name: lastName },
    });
    if (!data) {
      return { ok: false, message: extractFirstErrorMessage(error) };
    }

    const user = await this.fetchCurrentUser(data.access);
    if (!user) {
      return { ok: false, message: 'Registered, but could not load your account. Try again.' };
    }

    this.authStore.setSession(data.access, data.refresh, user);
    return { ok: true };
  }

  async acceptClientInvitation(
    token: string,
    phone: string,
    password: string
  ): Promise<LoginResult> {
    const { data, error } = await this.api.POST('/api/v1/client-invitations/{token}/complete/', {
      params: { path: { token } },
      body: { phone, password },
    });
    if (!data) {
      return { ok: false, message: extractFirstErrorMessage(error) };
    }

    const user = await this.fetchCurrentUser(data.access);
    if (!user) {
      return { ok: false, message: 'Registered, but could not load your account. Try again.' };
    }

    this.authStore.setSession(data.access, data.refresh, user);
    return { ok: true };
  }

  async acceptStaffInvitation(token: string, password: string): Promise<LoginResult> {
    const { data, error } = await this.api.POST('/api/v1/staff/invitations/{token}/accept/', {
      params: { path: { token } },
      body: { password },
    });
    if (!data) {
      return { ok: false, message: extractFirstErrorMessage(error) };
    }

    const user = await this.fetchCurrentUser(data.access);
    if (!user) {
      return { ok: false, message: 'Registered, but could not load your account. Try again.' };
    }

    this.authStore.setSession(data.access, data.refresh, user);
    return { ok: true };
  }

  async login(email: string, password: string, client?: string): Promise<LoginResult> {
    switch (this.audience) {
      case 'customer':
        return this.handleTokenResponse(
          this.api.POST('/api/v1/auth/customer/token/', { body: { email, password, client } })
        );
      case 'client-admin':
        return this.handleTokenResponse(
          this.api.POST('/api/v1/auth/client-admin/token/', {
            body: { email, password, client },
          })
        );
      case 'super-admin':
        return this.handleTokenResponse(
          this.api.POST('/api/v1/auth/super-admin/token/', { body: { email, password } })
        );
    }
  }

  logout(): void {
    this.authStore.clear();
  }

  private async handleTokenResponse(
    request: Promise<{
      data?: { access: string; refresh: string };
      error?: { detail?: string };
    }>
  ): Promise<LoginResult> {
    const { data, error } = await request;
    if (!data) {
      return { ok: false, message: error?.detail ?? 'Sign-in failed. Check your details and try again.' };
    }

    const user = await this.fetchCurrentUser(data.access);
    if (!user) {
      return { ok: false, message: 'Signed in, but could not load your account. Try again.' };
    }

    this.authStore.setSession(data.access, data.refresh, user);
    return { ok: true };
  }

  private async fetchCurrentUser(accessToken: string): Promise<AuthUser | null> {
    // **The only hand-written `Authorization` header left in this
    // workspace, and deliberately so.** Everywhere else `@auth`'s
    // `authMiddleware` attaches it (docs/specs/13-session-resilience.md);
    // here the token has just been issued and is not in `AuthStore` yet —
    // this call is what fetches the user the session is built from. The
    // middleware's "never overwrite an explicit header" rule exists for
    // exactly this request.
    const { data } = await this.api.GET('/api/v1/auth/me/', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!data) {
      return null;
    }
    return {
      id: data.id,
      email: data.email,
      firstName: data.first_name,
      lastName: data.last_name,
      client: data.client,
      isPlatformStaff: data.is_platform_staff,
      isClientStaff: data.is_client_staff,
      permissions: data.permissions,
      roleName: data.role_name,
      clientName: data.client_name,
    };
  }
}
