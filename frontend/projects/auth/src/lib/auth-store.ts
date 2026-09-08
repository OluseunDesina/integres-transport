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
 * refresh doesn't log the user out.
 *
 * Silent refresh lands on top of this via `@auth`'s `authMiddleware`
 * (docs/specs/13-session-resilience.md), which reads `refreshToken()`
 * and writes both rotated tokens back through `updateTokens()`. The
 * refresh token stays in `localStorage` alongside the access token;
 * moving it to an httpOnly cookie is a real hardening step that spec
 * names and defers, since it drags in CSRF handling and a cross-origin
 * cookie policy for the white-labeled custom domains.
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly session = signal<AuthSession | null>(this.restore());

  readonly user = computed(() => this.session()?.user ?? null);
  readonly accessToken = computed(() => this.session()?.accessToken ?? null);
  readonly refreshToken = computed(() => this.session()?.refreshToken ?? null);
  readonly isAuthenticated = computed(() => this.session() !== null);

  setSession(accessToken: string, refreshToken: string, user: AuthUser): void {
    const next: AuthSession = { accessToken, refreshToken, user };
    this.session.set(next);
    this.persist(next);
  }

  /** Replaces both tokens on the existing session, keeping `user`.
   *
   * Distinct from `setSession()` because the refresh response carries no
   * `AuthUser` to pass it. **Both** tokens are replaced, never just the
   * access one: `ROTATE_REFRESH_TOKENS` is on server-side, so each
   * refresh invalidates nothing but does hand back a new refresh token,
   * and a client that keeps the old one silently loses its session when
   * that original expires.
   *
   * A no-op with no session — a refresh cannot resurrect one, and
   * writing a session with no `user` would make `isAuthenticated()` true
   * for a session nothing can render. */
  updateTokens(accessToken: string, refreshToken: string): void {
    const current = this.session();
    if (!current) {
      return;
    }
    const next: AuthSession = { ...current, accessToken, refreshToken };
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
