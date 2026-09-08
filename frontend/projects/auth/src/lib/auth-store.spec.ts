import { TestBed } from '@angular/core/testing';

import { AuthStore } from './auth-store';
import type { AuthUser } from './auth-user';

const user: AuthUser = {
  id: 'user-1',
  email: 'passenger@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  client: 'client-1',
  isPlatformStaff: false,
  isClientStaff: false,
  permissions: ['customer:access'],
  roleName: null,
  clientName: null,
};

describe('AuthStore', () => {
  let store: AuthStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    store = TestBed.inject(AuthStore);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('starts unauthenticated when nothing is persisted', () => {
    expect(store.isAuthenticated()).toBeFalse();
    expect(store.user()).toBeNull();
    expect(store.accessToken()).toBeNull();
  });

  it('setSession() populates signals and persists to localStorage', () => {
    store.setSession('access-token', 'refresh-token', user);

    expect(store.isAuthenticated()).toBeTrue();
    expect(store.accessToken()).toBe('access-token');
    expect(store.user()).toEqual(user);

    const raw = localStorage.getItem('integra.auth.session');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).user).toEqual(user);
  });

  it('clear() resets signals and removes persisted session', () => {
    store.setSession('access-token', 'refresh-token', user);

    store.clear();

    expect(store.isAuthenticated()).toBeFalse();
    expect(store.user()).toBeNull();
    expect(localStorage.getItem('integra.auth.session')).toBeNull();
  });

  it('restores a persisted session on construction', () => {
    localStorage.setItem(
      'integra.auth.session',
      JSON.stringify({ accessToken: 'a', refreshToken: 'r', user })
    );

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const restored = TestBed.inject(AuthStore);

    expect(restored.isAuthenticated()).toBeTrue();
    expect(restored.user()).toEqual(user);
  });

  it('ignores corrupt persisted data instead of throwing', () => {
    localStorage.setItem('integra.auth.session', 'not-json');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const restored = TestBed.inject(AuthStore);

    expect(restored.isAuthenticated()).toBeFalse();
  });

  // --- Silent refresh (docs/specs/13-session-resilience.md) ---

  it('exposes the refresh token', () => {
    expect(store.refreshToken()).toBeNull();

    store.setSession('access-token', 'refresh-token', user);

    expect(store.refreshToken()).toBe('refresh-token');
  });

  it('updateTokens() replaces both tokens, keeps the user, and re-persists', () => {
    store.setSession('access-1', 'refresh-1', user);

    store.updateTokens('access-2', 'refresh-2');

    expect(store.accessToken()).toBe('access-2');
    // The rotated refresh token specifically: keeping the old one is the
    // failure that silently kills a session once it expires.
    expect(store.refreshToken()).toBe('refresh-2');
    expect(store.user()).toEqual(user);

    const persisted = JSON.parse(localStorage.getItem('integra.auth.session') as string);
    expect(persisted.accessToken).toBe('access-2');
    expect(persisted.refreshToken).toBe('refresh-2');
    expect(persisted.user).toEqual(user);
  });

  it('updateTokens() is a no-op with no session', () => {
    store.updateTokens('access', 'refresh');

    expect(store.isAuthenticated()).toBeFalse();
    expect(localStorage.getItem('integra.auth.session')).toBeNull();
  });
});
