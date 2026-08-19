import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideApiClient } from '@api-client';
import { AUTH_AUDIENCE, WhiteLabelResolverService } from '@auth';

import { routes } from './app.routes';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideApiClient(environment.apiBaseUrl),
    { provide: AUTH_AUDIENCE, useValue: 'client-admin' },
    // Resolves this Client's white-label branding from the browser's Host
    // header before the router activates the login route — see
    // docs/specs/1-identity-client-business.md §5. Never blocks boot: a
    // 404 (local dev, an unconfigured Client) just leaves clientId null.
    provideAppInitializer(() => inject(WhiteLabelResolverService).resolve()),
  ],
};
