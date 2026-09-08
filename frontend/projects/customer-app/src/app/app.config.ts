import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
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
    { provide: AUTH_AUDIENCE, useValue: 'customer' },
    // See docs/specs/1-identity-client-business.md §5 — same white-label
    // resolution the client-admin app wires, closing Phase 0's
    // subdomain-resolution gap for the passenger-facing app too.
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
  ],
};
