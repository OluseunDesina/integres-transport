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
    { provide: AUTH_AUDIENCE, useValue: 'customer' },
    // See docs/specs/1-identity-client-business.md §5 — same white-label
    // resolution the client-admin app wires, closing Phase 0's
    // subdomain-resolution gap for the passenger-facing app too.
    provideAppInitializer(() => inject(WhiteLabelResolverService).resolve()),
  ],
};
