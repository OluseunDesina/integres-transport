import type { EnvironmentProviders, Provider } from '@angular/core';
import { InjectionToken, makeEnvironmentProviders } from '@angular/core';

import { type ApiClient, createApiClient } from './create-client';
import type { Middleware } from './create-client';

export const API_CLIENT = new InjectionToken<ApiClient>('API_CLIENT');

/**
 * Registers the typed OpenAPI client for injection via `inject(API_CLIENT)`.
 * Each app calls this once in `app.config.ts` with its own
 * `environment.apiBaseUrl` — see docs/adr/0001 on environment files.
 *
 * `middleware` is a **factory**, not an array, and deliberately so: the
 * middleware this exists for (`@auth`'s `authMiddleware`, see
 * docs/specs/13-session-resilience.md) needs `inject(AuthStore)`, and
 * `useFactory` is the only place an injection context exists. Passing a
 * prebuilt array would force every caller to construct its middleware
 * outside DI.
 */
export function provideApiClient(
  baseUrl: string,
  middleware: () => Middleware[] = () => []
): EnvironmentProviders {
  const provider: Provider = {
    provide: API_CLIENT,
    useFactory: () => createApiClient(baseUrl, middleware()),
  };
  return makeEnvironmentProviders([provider]);
}
