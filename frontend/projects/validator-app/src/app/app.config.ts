import {
  ApplicationConfig,
  inject,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
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
    // Staff operating the validator sign in through the same
    // client-admin-scoped JWT/RBAC as client-admin-app — `tapngo.record`
    // is a Role/Permission codename like any other client-admin one, not
    // a new audience. See docs/specs/4b-tap-and-go.md's "Operator
    // harness" section.
    { provide: AUTH_AUDIENCE, useValue: 'client-admin' },
    provideAppInitializer(() => inject(WhiteLabelResolverService).resolve()),
    // Installable PWA — see docs/specs/4b-tap-and-go.md's "Operator
    // harness" section: this app stands in for the not-yet-built
    // Flutter validator app, and being installable on a conductor's own
    // phone/tablet is the point. Disabled in dev mode (default schematic
    // behavior) so `ng serve` iteration is never fighting a cached
    // service worker.
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
