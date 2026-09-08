import { InjectionToken, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { API_CLIENT, provideApiClient } from './api-client.token';

describe('provideApiClient', () => {
  it('registers a typed client resolvable via API_CLIENT', () => {
    TestBed.configureTestingModule({
      providers: [provideApiClient('http://localhost:8000/api/v1')],
    });

    const client = TestBed.inject(API_CLIENT);

    expect(typeof client.GET).toBe('function');
    expect(typeof client.POST).toBe('function');
  });

  it('builds its middleware inside the injection context', () => {
    // The factory shape exists so `@auth`'s authMiddleware can call
    // inject(AuthStore) — see docs/specs/13-session-resilience.md. If this
    // were a plain array parameter, it would have to be constructed
    // outside DI and could not.
    const token = new InjectionToken<string>('marker', {
      providedIn: 'root',
      factory: () => 'injected',
    });
    const seen: string[] = [];

    TestBed.configureTestingModule({
      providers: [
        provideApiClient('http://localhost:8000', () => {
          seen.push(inject(token));
          return [];
        }),
      ],
    });
    TestBed.inject(API_CLIENT);

    expect(seen).toEqual(['injected']);
  });
});
