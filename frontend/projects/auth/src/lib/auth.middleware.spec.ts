import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type { Middleware, MiddlewareCallbackParams } from '@api-client';

import { AuthStore } from './auth-store';
import { authMiddleware } from './auth.middleware';
import type { AuthUser } from './auth-user';

const BASE_URL = 'http://localhost:8000';
const REFRESH_URL = `${BASE_URL}/api/v1/auth/token/refresh/`;

const user: AuthUser = {
  id: 'user-1',
  email: 'staff@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  client: 'client-1',
  isPlatformStaff: false,
  isClientStaff: true,
  permissions: ['client-admin:access'],
  roleName: 'Owner',
  clientName: 'Integra',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('authMiddleware', () => {
  let store: AuthStore;
  let middleware: Middleware;
  let router: jasmine.SpyObj<Router>;
  let fetchSpy: jasmine.Spy;
  /** Responses the retried request should get, in order. The refresh call
   * is answered separately by `refreshResponses`. */
  let retryResponses: Response[];
  let refreshResponses: Response[];

  /** Only the fields the middleware reads. Cast because openapi-fetch's
   * `options` carries serializers this never touches. */
  function params(
    overrides: { request?: Request; schemaPath?: string; id?: string } = {}
  ): MiddlewareCallbackParams {
    return {
      request: overrides.request ?? new Request(`${BASE_URL}/api/v1/bookings/`),
      schemaPath: overrides.schemaPath ?? '/api/v1/bookings/',
      id: overrides.id ?? 'req-1',
      params: {},
      options: { baseUrl: BASE_URL, fetch: fetchSpy },
    } as unknown as MiddlewareCallbackParams;
  }

  /** Drives a full request/response cycle the way openapi-fetch does:
   * `onRequest` first (which is what stashes the retryable clone), then
   * `onResponse` with the same id. */
  async function cycle(
    responseStatus: number,
    overrides: { request?: Request; schemaPath?: string; id?: string } = {}
  ): Promise<{ sent: Request; result: Response | undefined }> {
    const p = params(overrides);
    const rewritten = await middleware.onRequest?.(p);
    const sent = (rewritten as Request | undefined) ?? p.request;
    const result = await middleware.onResponse?.({
      ...p,
      request: sent,
      response: new Response(null, { status: responseStatus }),
    });
    return { sent, result: result as Response | undefined };
  }

  beforeEach(() => {
    localStorage.clear();
    router = jasmine.createSpyObj<Router>('Router', ['navigate']);
    TestBed.configureTestingModule({
      providers: [{ provide: Router, useValue: router }],
    });
    store = TestBed.inject(AuthStore);
    middleware = TestBed.runInInjectionContext(() => authMiddleware());

    retryResponses = [jsonResponse({ ok: true })];
    refreshResponses = [jsonResponse({ access: 'access-2', refresh: 'refresh-2' })];
    fetchSpy = jasmine.createSpy('fetch').and.callFake((input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      const queue = url === REFRESH_URL ? refreshResponses : retryResponses;
      return Promise.resolve(queue.shift() ?? jsonResponse({}, 500));
    });
  });

  afterEach(() => localStorage.clear());

  describe('onRequest', () => {
    it('attaches the access token when a session exists', async () => {
      store.setSession('access-1', 'refresh-1', user);

      const rewritten = (await middleware.onRequest?.(params())) as Request;

      expect(rewritten.headers.get('Authorization')).toBe('Bearer access-1');
    });

    it('attaches nothing when there is no session', async () => {
      const rewritten = await middleware.onRequest?.(params());

      expect(rewritten).toBeUndefined();
    });

    it('does not overwrite an explicitly supplied header', async () => {
      // AuthApiService.fetchCurrentUser passes a token that is not yet in
      // the store — it is fetching the user the session is built from.
      store.setSession('access-1', 'refresh-1', user);
      const request = new Request(`${BASE_URL}/api/v1/auth/me/`, {
        headers: { Authorization: 'Bearer not-yet-stored' },
      });

      const rewritten = await middleware.onRequest?.(params({ request, schemaPath: '/api/v1/auth/me/' }));

      expect(rewritten).toBeUndefined();
      expect(request.headers.get('Authorization')).toBe('Bearer not-yet-stored');
    });

    it('attaches nothing on an anonymous path', async () => {
      store.setSession('access-1', 'refresh-1', user);

      const rewritten = await middleware.onRequest?.(
        params({ schemaPath: '/api/v1/auth/client-admin/token/' })
      );

      expect(rewritten).toBeUndefined();
    });

    it('still attaches on authenticated paths that sit under an anonymous one', async () => {
      // The anonymous list is matched by prefix, so a sibling path can be
      // swallowed by an entry meant for its neighbours. `POST
      // /api/v1/staff/invitations/` creates an invitation and requires
      // `staff.invite`; only its `{token}/` resolve and `{token}/accept/`
      // siblings are AllowAny. A bare `/api/v1/staff/invitations/` entry
      // stripped the header from the create call, which then 401'd with no
      // refresh attempted because it looked anonymous. Found by an e2e
      // once the hand-written header stopped masking it.
      store.setSession('access-1', 'refresh-1', user);

      const authenticated = (await middleware.onRequest?.(
        params({ schemaPath: '/api/v1/staff/invitations/' })
      )) as Request;
      expect(authenticated.headers.get('Authorization')).toBe('Bearer access-1');

      for (const anonymous of [
        '/api/v1/staff/invitations/{token}/',
        '/api/v1/staff/invitations/{token}/accept/',
        '/api/v1/client-invitations/{token}/',
        '/api/v1/client-invitations/{token}/complete/',
      ]) {
        expect(await middleware.onRequest?.(params({ schemaPath: anonymous })))
          .withContext(anonymous)
          .toBeUndefined();
      }
    });
  });

  describe('onResponse', () => {
    beforeEach(() => store.setSession('access-1', 'refresh-1', user));

    it('passes a successful response through untouched', async () => {
      const { result } = await cycle(200);

      expect(result).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('never refreshes on 403 — a permission denial is not an expiry', async () => {
      const { result } = await cycle(403);

      expect(result).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('never refreshes on a 401 from an anonymous path', async () => {
      // A wrong password must not fire a refresh, nor clear a session.
      const { result } = await cycle(401, { schemaPath: '/api/v1/auth/client-admin/token/' });

      expect(result).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(store.isAuthenticated()).toBeTrue();
    });

    it('refreshes on 401 and retries the request with the new token', async () => {
      const { result } = await cycle(401);

      expect(fetchSpy.calls.count()).toBe(2);
      expect(fetchSpy.calls.first().args[0]).toBe(REFRESH_URL);

      const retried = fetchSpy.calls.mostRecent().args[0] as Request;
      expect(retried.headers.get('Authorization')).toBe('Bearer access-2');
      expect(result?.status).toBe(200);
    });

    it('persists the rotated refresh token, not just the access token', async () => {
      await cycle(401);

      expect(store.accessToken()).toBe('access-2');
      // Keeping refresh-1 here is the bug that silently kills the session
      // a week later, when the original refresh token expires.
      expect(store.refreshToken()).toBe('refresh-2');
      expect(store.user()).toEqual(user);
    });

    it('replays the original body on retry', async () => {
      const request = new Request(`${BASE_URL}/api/v1/bookings/`, {
        method: 'POST',
        body: JSON.stringify({ trip: 'trip-1' }),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1' },
      });

      await cycle(401, { request });

      const retried = fetchSpy.calls.mostRecent().args[0] as Request;
      // The retry is only safe because the same Idempotency-Key rides
      // along — a regenerated key would turn one booking into two.
      expect(retried.headers.get('Idempotency-Key')).toBe('key-1');
      expect(await retried.text()).toBe(JSON.stringify({ trip: 'trip-1' }));
    });

    it('clears the session and surfaces the original 401 when refresh fails', async () => {
      refreshResponses = [new Response(null, { status: 401 })];

      const { result } = await cycle(401);

      expect(store.isAuthenticated()).toBeFalse();
      expect(result).toBeUndefined();
      // Refresh attempted, retry not.
      expect(fetchSpy.calls.count()).toBe(1);
    });

    it('navigates to /login when refresh fails', async () => {
      // permissionGuard cannot cover this: it runs on route *activation*,
      // and a session dying mid-request leaves the route already active.
      // Without this the screen just stops having data and says nothing.
      // Found by an e2e, not by this suite.
      refreshResponses = [new Response(null, { status: 401 })];

      await cycle(401);

      expect(router.navigate).toHaveBeenCalledWith(['/login']);
    });

    it('does not navigate when the refresh succeeds', async () => {
      await cycle(401);

      expect(router.navigate).not.toHaveBeenCalled();
    });

    it('never calls fetch as a method on the options object', async () => {
      // Regression guard for a real browser-only bug: `options.fetch(...)`
      // sets `this` to the options object, and native fetch answers that
      // with "Illegal invocation". It must be called bare, the way
      // openapi-fetch calls its own. A plain spy cannot see `this`, so the
      // spy records it explicitly.
      const receivers: unknown[] = [];
      fetchSpy = jasmine.createSpy('fetch').and.callFake(function (
        this: unknown,
        input: Request | string
      ) {
        receivers.push(this);
        const url = typeof input === 'string' ? input : input.url;
        const queue = url === REFRESH_URL ? refreshResponses : retryResponses;
        return Promise.resolve(queue.shift() ?? jsonResponse({}, 500));
      });

      await cycle(401);

      expect(receivers.length).toBe(2);
      for (const receiver of receivers) {
        expect(receiver).toBeUndefined();
      }
    });

    it('does not refresh when there is no refresh token to present', async () => {
      store.clear();
      store.setSession('access-1', '', user);

      const { result } = await cycle(401);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
      expect(store.isAuthenticated()).toBeFalse();
    });

    it('returns a second 401 as-is rather than retrying again', async () => {
      retryResponses = [new Response(null, { status: 401 })];

      const { result } = await cycle(401);

      // One refresh, one retry, and then it stops: the retry goes through
      // options.fetch, so it cannot re-enter this callback and loop.
      expect(fetchSpy.calls.count()).toBe(2);
      expect(result?.status).toBe(401);
    });

    it('makes exactly one refresh call for five concurrent 401s', async () => {
      // The load-bearing property. Six dashboard requests expiring together
      // must not become six refreshes.
      retryResponses = [
        jsonResponse({ n: 1 }),
        jsonResponse({ n: 2 }),
        jsonResponse({ n: 3 }),
        jsonResponse({ n: 4 }),
        jsonResponse({ n: 5 }),
      ];

      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => cycle(401, { id: `req-${n}` }))
      );

      const refreshCalls = fetchSpy.calls
        .allArgs()
        .filter(([input]) => input === REFRESH_URL);
      expect(refreshCalls.length).toBe(1);

      for (const { result } of results) {
        expect(result?.status).toBe(200);
      }
      for (const call of fetchSpy.calls.allArgs()) {
        if (call[0] !== REFRESH_URL) {
          expect((call[0] as Request).headers.get('Authorization')).toBe('Bearer access-2');
        }
      }
    });

    it('refreshes again on a later 401, once the first refresh has settled', async () => {
      // Proves the in-flight promise is cleared rather than latched.
      await cycle(401, { id: 'req-1' });
      refreshResponses = [jsonResponse({ access: 'access-3', refresh: 'refresh-3' })];
      retryResponses = [jsonResponse({ ok: true })];

      await cycle(401, { id: 'req-2' });

      expect(store.accessToken()).toBe('access-3');
    });
  });
});
