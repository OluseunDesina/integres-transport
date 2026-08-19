import type { EnvironmentProviders, Provider } from '@angular/core';
import { InjectionToken, makeEnvironmentProviders } from '@angular/core';

import { type ApiClient, createApiClient } from './create-client';

export const API_CLIENT = new InjectionToken<ApiClient>('API_CLIENT');

/**
 * Registers the typed OpenAPI client for injection via `inject(API_CLIENT)`.
 * Each app calls this once in `app.config.ts` with its own
 * `environment.apiBaseUrl` — see docs/adr/0001 on environment files.
 */
export function provideApiClient(baseUrl: string): EnvironmentProviders {
  const provider: Provider = {
    provide: API_CLIENT,
    useFactory: () => createApiClient(baseUrl),
  };
  return makeEnvironmentProviders([provider]);
}
