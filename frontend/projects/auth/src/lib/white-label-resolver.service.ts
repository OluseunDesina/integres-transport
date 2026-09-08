import { Injectable, inject, signal } from '@angular/core';
import { API_CLIENT } from '@api-client';

/**
 * Closes Phase 0's subdomain-resolution gap
 * (docs/specs/1-identity-client-business.md §5): calls
 * `GET /white-label/resolve/` — resolved by the request's `Host` header,
 * server-side — once at app boot, so `login.ts` can pass the resolved
 * Client id instead of a real user having to know a UUID.
 *
 * Never blocks boot: no matching domain (local dev, an unconfigured
 * Client) 404s, and any other failure (network, etc.) is swallowed the
 * same way — both resolve `clientId` to `null`, falling back to the
 * existing manual `client` disambiguation field.
 */
/**
 * The tenant's branding, as resolved from the request's host.
 *
 * `GET /white-label/resolve/` has always returned these alongside
 * `client_id`; until docs/specs/14-design-system-and-ui-rebuild.md they
 * were read by nothing at all, which is why a white-label platform did
 * not actually white-label anything. Applying them is `@shared-ui`'s
 * `BrandThemeService`, composed by each app — this library only carries
 * the data.
 */
export interface WhiteLabelBranding {
  name: string | null;
  logo: string | null;
  primary: string | null;
  secondary: string | null;
}

@Injectable({ providedIn: 'root' })
export class WhiteLabelResolverService {
  private readonly api = inject(API_CLIENT);

  readonly clientId = signal<string | null>(null);
  readonly branding = signal<WhiteLabelBranding | null>(null);

  async resolve(): Promise<void> {
    try {
      const { data } = await this.api.GET('/api/v1/white-label/resolve/');
      this.clientId.set(data?.client_id ?? null);
      // Empty strings are the serializer's "not configured" for these
      // (they are `blank=True` CharFields, never null), so they are
      // normalised to null rather than passed on as a falsy colour.
      this.branding.set(
        data
          ? {
              name: data.name || null,
              logo: data.logo || null,
              primary: data.primary_color || null,
              secondary: data.secondary_color || null,
            }
          : null
      );
    } catch {
      this.clientId.set(null);
      this.branding.set(null);
    }
  }
}
