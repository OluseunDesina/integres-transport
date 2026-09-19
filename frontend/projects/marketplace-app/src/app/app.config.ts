import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideApiClient } from '@api-client';
import { AUTH_AUDIENCE, authMiddleware } from '@auth';

import { routes } from './app.routes';
import { environment } from '../environments/environment';

// No `WhiteLabelResolverService`/`BrandThemeService` step here, unlike
// `customer-app`'s own `app.config.ts` — this app has no single Client
// or subdomain to resolve branding for. It's the "TransitOS Mobile"
// marketplace surface itself (docs/adr/0009, docs/specs/22-marketplace.md):
// one platform-owned look, not a per-operator white label.
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideApiClient(environment.apiBaseUrl, () => [authMiddleware()]),
    { provide: AUTH_AUDIENCE, useValue: 'customer' },
  ],
};
