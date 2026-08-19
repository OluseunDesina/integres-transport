import { Injectable, computed, signal } from '@angular/core';

import type { AuthUser } from './auth-user';

interface AuthSession {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

const STORAGE_KEY = 'integra.auth.session';

/**
 * Session state for the current app. Not a `ListStore` (see
 * @shared-data) — a single session isn't a paginated collection, so it
 * doesn't fit that shape. Tokens persist to `localStorage` so a page
 * refresh doesn't log the user out; see docs/adr/0005 for how this will
 * need to change once short-lived access tokens + silent refresh land
 * (Phase 1+).
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly session = signal<AuthSession | null>(this.restore());

  readonly user = computed(() => this.session()?.user ?? null);
  readonly accessToken = computed(() => this.session()?.accessToken ?? null);
  readonly isAuthenticated = computed(() => this.session() !== null);

  setSession(accessToken: string, refreshToken: string, user: AuthUser): void {
    const next: AuthSession = { accessToken, refreshToken, user };
    this.session.set(next);
    this.persist(next);
  }

  clear(): void {
    this.session.set(null);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  private restore(): AuthSession | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as AuthSession;
    } catch {
      return null;
    }
  }

  private persist(session: AuthSession): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    }
  }
}
