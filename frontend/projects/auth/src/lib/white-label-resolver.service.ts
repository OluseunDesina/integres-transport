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
@Injectable({ providedIn: 'root' })
export class WhiteLabelResolverService {
  private readonly api = inject(API_CLIENT);

  readonly clientId = signal<string | null>(null);

  async resolve(): Promise<void> {
    try {
      const { data } = await this.api.GET('/api/v1/white-label/resolve/');
      this.clientId.set(data?.client_id ?? null);
    } catch {
      this.clientId.set(null);
    }
  }
}
