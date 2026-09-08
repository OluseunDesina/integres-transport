import { inject } from '@angular/core';
import { Router } from '@angular/router';
import type { Middleware } from '@api-client';

import { AuthStore } from './auth-store';

/**
 * OpenAPI-fetch middleware that attaches `Authorization` and transparently
 * refreshes an expired access token — see
 * docs/specs/13-session-resilience.md.
 *
 * Lives in `@auth` rather than `@api-client` because it needs `AuthStore`;
 * the reverse import would invert the library dependency and create a
 * cycle. Apps wire it in `app.config.ts`:
 *
 * ```ts
 * provideApiClient(environment.apiBaseUrl, () => [authMiddleware()])
 * ```
 *
 * Call it inside that factory, not at module scope — it uses `inject()`.
 */

/**
 * Paths that are reachable without a session. Matched against
 * openapi-fetch's `schemaPath` (the OpenAPI template, e.g.
 * `/api/v1/bookings/{id}/cancel/`) rather than the resolved URL, so path
 * parameters can't smuggle a value past a prefix check.
 *
 * These get no header and, critically, **never trigger a refresh**: a 401
 * from a login endpoint means "wrong password", not "session expired",
 * and refreshing on it would fire a pointless request and could clear a
 * perfectly good session belonging to someone re-authenticating.
 */
const ANONYMOUS_PATH_PREFIXES = [
  '/api/v1/auth/customer/token/',
  '/api/v1/auth/client-admin/token/',
  '/api/v1/auth/super-admin/token/',
  '/api/v1/auth/token/refresh/',
  '/api/v1/clients/register/',
  // Both `{token}/` entries are AllowAny (resolve and complete); creating
  // a client invitation lives at /api/v1/super-admin/client-invitations/
  // and is not matched here.
  '/api/v1/client-invitations/{token}/',
  // **`{token}/` and not the bare prefix.** `POST /api/v1/staff/invitations/`
  // *creates* an invitation and requires `staff.invite`; only the
  // `{token}/` resolve and `{token}/accept/` paths are AllowAny. Matching
  // the bare prefix silently stripped the header from the create call —
  // it went out unauthenticated and 401'd, with no refresh attempted
  // because it looked anonymous.
  '/api/v1/staff/invitations/{token}/',
  '/api/v1/white-label/resolve/',
  // Server-to-server; not in the generated client schema at all today.
  // Kept as a guard in case a future regeneration adds it.
  '/api/v1/webhooks/',
  '/api/v1/health/',
  '/api/v1/readiness/',
];

function isAnonymous(schemaPath: string): boolean {
  return ANONYMOUS_PATH_PREFIXES.some((prefix) => schemaPath.startsWith(prefix));
}

function withAuthorization(request: Request, accessToken: string): Request {
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  return new Request(request, { headers });
}

interface RefreshResponse {
  access?: string;
  refresh?: string;
}

export function authMiddleware(): Middleware {
  const authStore = inject(AuthStore);
  const router = inject(Router);

  /**
   * The single in-flight refresh, shared by every concurrent 401.
   *
   * A dashboard firing six requests at once gets six simultaneous 401s.
   * Six refreshes would be six round trips where one would do — and once
   * refresh-token blacklisting is ever turned on server-side (it is
   * currently off, see config/settings/base.py) five of them would be
   * presenting an already-rotated token and would kill the session at
   * exactly the moment it should have recovered.
   *
   * Scoped to this middleware instance, not the module: two apps in one
   * test run must not share a refresh.
   */
  let inFlightRefresh: Promise<boolean> | null = null;

  /**
   * The original request, cloned before its body is read, keyed by the
   * per-request id openapi-fetch hands both callbacks.
   *
   * By `onResponse` the request that was actually sent has had its body
   * consumed, so retrying it directly would send an empty body. The clone
   * is taken in `onRequest`, while the body is still unread.
   */
  const pendingRequests = new Map<string, Request>();

  async function refresh(baseUrl: string, doFetch: typeof globalThis.fetch): Promise<boolean> {
    const refreshToken = authStore.refreshToken();
    if (!refreshToken) {
      return false;
    }

    try {
      // A plain fetch, not a call through the typed client: going through
      // the client would re-enter this very middleware. The exclusion list
      // above would stop the recursion, but not needing it at all is the
      // stronger guarantee.
      const response = await doFetch(`${baseUrl}/api/v1/auth/token/refresh/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: refreshToken }),
      });
      if (!response.ok) {
        return false;
      }
      const data = (await response.json()) as RefreshResponse;
      if (!data.access || !data.refresh) {
        return false;
      }
      authStore.updateTokens(data.access, data.refresh);
      return true;
    } catch {
      // Network failure, not an auth failure. Reported as "couldn't
      // refresh" so the original 401 surfaces; the session is cleared by
      // the caller either way, since we have no way to tell a dead
      // refresh token from a dead connection here.
      return false;
    }
  }

  return {
    onRequest({ request, schemaPath, id }) {
      if (isAnonymous(schemaPath)) {
        return undefined;
      }

      // Stashed regardless of whether we attach a header: a call site that
      // supplied its own Authorization (see below) is still eligible for
      // refresh-and-retry, and still needs an unconsumed body to retry with.
      pendingRequests.set(id, request.clone());

      // An explicitly-supplied header wins. `AuthApiService.fetchCurrentUser`
      // deliberately passes a token that is not yet in the store — it is
      // fetching the user the session is about to be built from — and must
      // keep working.
      if (request.headers.has('Authorization')) {
        return undefined;
      }

      const accessToken = authStore.accessToken();
      return accessToken ? withAuthorization(request, accessToken) : undefined;
    },

    async onResponse({ response, schemaPath, id, options }) {
      const original = pendingRequests.get(id);
      pendingRequests.delete(id);

      if (response.status !== 401 || isAnonymous(schemaPath) || !original) {
        // 403 lands here too, deliberately. It means "this role may not do
        // this", which no amount of refreshing fixes; treating it as expiry
        // would refresh-loop on every legitimate permission denial.
        return undefined;
      }

      // Destructured to a local and called bare, never as
      // `options.fetch(...)`. A method call sets `this` to the options
      // object, and the browser's native fetch rejects that with
      // "Illegal invocation" — openapi-fetch's own internals call it bare
      // for the same reason. A unit-test spy does not care, so this only
      // shows up in a real browser; it did, on the retry below.
      const { fetch: doFetch } = options;

      inFlightRefresh ??= refresh(options.baseUrl, doFetch).finally(() => {
        inFlightRefresh = null;
      });
      const refreshed = await inFlightRefresh;

      if (!refreshed) {
        authStore.clear();
        // Navigated explicitly, because `permissionGuard` cannot cover
        // this: it runs when a route is *activated*, and a session dying
        // mid-request means the route is already active. Without this the
        // screen simply stops having data and says nothing — which is the
        // exact defect this spec exists to fix, just moved later.
        //
        // The original 401 is still returned unchanged so the caller's own
        // error handling runs.
        void router.navigate(['/login']);
        return undefined;
      }

      const accessToken = authStore.accessToken();
      if (!accessToken) {
        return undefined;
      }

      // Retried through the raw fetch rather than the typed client, so it
      // cannot pass through this callback a second time. There is no retry
      // counter because there is no second retry to count: a 401 on this
      // response is a real authorization failure and is returned as-is.
      return doFetch(withAuthorization(original, accessToken));
    },
  };
}
