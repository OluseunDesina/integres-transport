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
import { AUTH_AUDIENCE, WhiteLabelResolverService, authMiddleware } from '@auth';
import { BrandThemeService } from '@shared-ui';

import { routes } from './app.routes';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideApiClient(environment.apiBaseUrl, () => [authMiddleware()]),
    // Staff operating the validator sign in through the same
    // client-admin-scoped JWT/RBAC as client-admin-app — `tapngo.record`
    // is a Role/Permission codename like any other client-admin one, not
    // a new audience. See docs/specs/4b-tap-and-go.md's "Operator
    // harness" section.
    { provide: AUTH_AUDIENCE, useValue: 'client-admin' },
    // Resolve the tenant's white-label config, then apply its brand
    // colour. Composed here rather than inside either library: `@auth`
    // carries the data, `@shared-ui` owns colour, and neither needs to
    // import the other (docs/specs/14-design-system-and-ui-rebuild.md).
    provideAppInitializer(async () => {
      const whiteLabel = inject(WhiteLabelResolverService);
      const theme = inject(BrandThemeService);
      await whiteLabel.resolve();
      theme.apply(whiteLabel.branding());
    }),
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
