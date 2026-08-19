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
});
