# 13-Session-Resilience: Token lifetime, silent refresh, centralised auth

First spec of the Transit OS adoption arc (see
`docs/specs/README-transit-os-adoption.md` for the roadmap this belongs
to). Written first because it is small, and because every long-lived
operations screen the later specs add — a dashboard left open, a live
monitoring view, a multi-step incident form, a CSV export of a large
filtered range — is materially worse without it.

## Scope and non-goals

### The defect

`ACCESS_TOKEN_LIFETIME` is 15 minutes
(`backend/config/settings/base.py:185`). `AuthStore` receives a refresh
token, persists it to `localStorage`, and **never uses it** — the
class exposes `accessToken` and `user` as computed signals but no
`refreshToken` accessor at all
(`frontend/projects/auth/src/lib/auth-store.ts:25-27`). No app handles
a `401`.

The observable behaviour is that any session sitting idle for fifteen
minutes silently starts failing every request. Screens render empty
states or generic errors rather than "you have been signed out", and a
half-completed form is lost with no warning. This has been a known,
repeatedly-named gap since Phase 5 and is outside every spec written so
far.

A second defect surfaced while scoping this one, and belongs here
because it is the same seam: **there is no auth middleware.** The
`Authorization` header is attached by hand at **89 call sites across 69
files** (client-admin 44, customer 11, super-admin 10, validator 2,
`@layout` 1, `@auth` 1). `booking-confirm.ts:118` has a comment saying
as much. `provideApiClient(baseUrl)` accepts no middleware, even though
the `createApiClient(baseUrl, middleware)` it wraps already does
(`frontend/projects/api-client/src/lib/create-client.ts:15`).

This matters for the fix, not just for tidiness: a refresh-on-401
retry has to re-issue the original request with a *new* token, and
there is no single place that decides what token a request carries.

### In scope

- `ACCESS_TOKEN_LIFETIME` 15 → 60 minutes.
- A single openapi-fetch middleware that attaches `Authorization` and
  transparently refreshes on `401`, retrying the original request once.
- `provideApiClient` extended to accept middleware.
- Removal of all 89 ad-hoc header attachments.

### Non-goals

- **No new backend endpoint.** `POST /api/v1/auth/token/refresh/`
  already exists (`apps/identity/urls.py`, name `token-refresh`) and is
  already the SimpleJWT rotation view. The only backend change in this
  spec is one settings value.
- **No idle-timeout or absolute-session-lifetime policy.**
  `REFRESH_TOKEN_LIFETIME` stays 7 days. A deliberate "log out after N
  minutes of inactivity" control is a product decision, not this.
- **No refresh-token storage change.** It stays in `localStorage`
  alongside the access token. Moving to an httpOnly cookie is a real
  hardening step and a real architectural change (CSRF handling,
  cross-origin cookie policy for the white-labeled domains) — named
  here, deferred deliberately.
- No change to the audience-scoped login endpoints or to
  `AUTH_AUDIENCE`.

## Data model changes

**None.** Two settings values change:

```python
# backend/config/settings/base.py
SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=60),   # was 15
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),      # unchanged
    "ROTATE_REFRESH_TOKENS": True,                    # unchanged
    "BLACKLIST_AFTER_ROTATION": False,                # was True, and a no-op
    ...
}
```

`ROTATE_REFRESH_TOKENS` stays `True`, and that is load-bearing for the
frontend design below: **every successful refresh returns a new refresh
token.** A client that refreshes and fails to persist the returned
refresh token silently loses its session once the original expires.

**Correction, found while building this slice.**
`BLACKLIST_AFTER_ROTATION` read `True` but was **a silent no-op**:
`rest_framework_simplejwt.token_blacklist` is not in `INSTALLED_APPS`,
and SimpleJWT swallows the resulting `AttributeError` ("If blacklist app
not installed, `blacklist` method will not be present",
`serializers.py:129-136`). A rotated-away refresh token has always
stayed valid for its full `REFRESH_TOKEN_LIFETIME`.

This spec's first draft asserted the opposite, and built a frontend
design on it. **Revocation is bounded by `REFRESH_TOKEN_LIFETIME`
alone**, the setting now says so, and the flag is `False` rather than
left claiming a control that does nothing.

Turning it back on means the blacklist app, its migrations, a periodic
flush (no cron on the target hosting — another `apps.core` internal task
endpoint), **and** solving the multi-tab race below, which only becomes
dangerous once blacklisting is real. A backend test pins the current
behaviour so that change cannot happen quietly.

## API surface

No endpoint is added or changed. For reference, the existing one this
spec finally consumes:

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| `POST` | `/api/v1/auth/token/refresh/` | none (the refresh token *is* the credential) | `{ refresh }` | `{ access, refresh }` |

Because rotation is on, the response carries a **new** `refresh`. Both
values must be written back to `AuthStore`.

## Frontend design

### `AuthStore` gains a refresh accessor and a token-only update

`frontend/projects/auth/src/lib/auth-store.ts`:

- `readonly refreshToken = computed(() => this.session()?.refreshToken ?? null)`
- `updateTokens(accessToken: string, refreshToken: string): void` —
  replaces both tokens on the existing session, preserving `user`, and
  re-persists. Distinct from `setSession()`, which needs an `AuthUser`
  the refresh response does not carry.

The stale docstring at `auth-store.ts:16-19` ("see docs/adr/0005 for
how this will need to change once short-lived access tokens + silent
refresh land") is updated — that is what this spec lands, and the
reference to ADR-0005 is wrong regardless (ADR-0005 is QR ticket
signing).

### One middleware, in `@auth`, not `@api-client`

`@auth` already depends on `@api-client`. The middleware needs
`AuthStore`, so it lives in `@auth` (`auth.middleware.ts`) and is
handed to `@api-client` at provider time. The reverse — `@api-client`
importing `@auth` — would invert the dependency and create a cycle.

`provideApiClient` gains an optional second parameter:

```ts
export function provideApiClient(
  baseUrl: string,
  middleware: () => Middleware[] = () => []
): EnvironmentProviders
```

A factory, not an array: the middleware needs `inject(AuthStore)`, and
`useFactory` is the only place that injection context exists. Each
app's `app.config.ts` becomes:

```ts
provideApiClient(environment.apiBaseUrl, () => [inject(AuthMiddleware).middleware]),
```

### Middleware behaviour

`onRequest` — attach `Authorization: Bearer <accessToken()>` when a
token exists and the request does not already carry the header. The
"already carries" escape hatch matters: `AuthApiService.fetchCurrentUser`
deliberately passes a token that is not yet in the store, and must keep
working.

**Requests that must never get a header, and never trigger a refresh**
(an anonymous endpoint returning `401` is not a session problem):
`/auth/{customer,client-admin,super-admin}/token/`,
`/auth/token/refresh/`, `/clients/register/`,
`/client-invitations/{token}/**`, `/staff/invitations/{token}/**`,
`/white-label/resolve/`, `/webhooks/**`, `/health/`, `/readiness/`.
Held as an explicit path predicate, not inferred.

**Correction, found in Slice 2.** The list is prefix-matched, so an
entry can swallow an authenticated sibling. `POST
/api/v1/staff/invitations/` *creates* an invitation and requires
`staff.invite`; only its `{token}/` resolve and `{token}/accept/`
siblings are `AllowAny`. The first draft listed the bare
`/api/v1/staff/invitations/` prefix, which stripped the header from the
create call — it then `401`'d **with no refresh attempted**, because it
looked anonymous.

It went unnoticed through all of Slice 1 because the call site was still
attaching the header by hand; deleting that in Slice 2 is what exposed
it. Every entry must be checked against the actual schema paths beneath
it rather than assumed from the feature's name, and a test now pins both
halves — the create path gets a header, the two `{token}` paths do not.

`onResponse` — on `401`, for a request that is not on that list and
that has not already been retried:

1. Refresh, then retry the original request **once**, with the new
   token substituted into the header.
2. A second `401` after a successful refresh is a real authorisation
   failure, not an expiry. Return it; do not loop.
3. If refresh fails, clear the session and return the original `401`.

### Concurrent 401s share one refresh

A dashboard firing six aggregate requests at once will get six
simultaneous `401`s. Six refresh calls would mean five of them
presenting a token that rotation has already blacklisted — the session
dies, from a race, at exactly the moment it should have recovered.

The middleware holds a single module-scoped `Promise<boolean> | null`.
The first `401` starts the refresh and stores the promise; every other
`401` awaits the same promise. It is cleared when it settles, success
or failure. This is the single most important correctness property in
this spec and gets a dedicated test.

### Logout on unrecoverable failure

A failed refresh calls `authStore.clear()` **and navigates to
`/login`**.

**Correction, found by browser verification.** This spec's first draft
left redirection to `permissionGuard`, on the reasoning that it already
sends an unauthenticated session to `/login`. That is wrong: the guard
runs when a route is *activated*, and a session dying mid-request means
the route is already active. Nothing re-navigates, so the screen simply
stops having data and says nothing — the exact defect this spec exists
to fix, moved a few seconds later. An e2e caught it; no unit test could.

So the middleware does inject `Router`. The original worry — that this
makes it unusable from `@layout` and other library code — does not hold:
`Router` is injectable anywhere in an Angular app, and `@auth`'s own
`permission.guard.ts` already injects it.

### Calling `fetch`: bare, never as a method

`options.fetch(...)` sets `this` to the options object, and the
browser's native fetch answers that with
`TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`.
Destructure it first and call it bare, exactly as openapi-fetch's own
internals do (`dist/index.mjs:123`).

Recorded because a spy does not care what `this` is: **this passes every
unit test and fails in every real browser.** It shipped in the first
implementation of this slice and was caught only by running the flow for
real. A regression test now asserts the receiver is `undefined`.

### Removing the 89 ad-hoc attachments

Mechanical, and done as its own slice so the middleware is proven
before anything is stripped. Each site drops
`headers: { Authorization: \`Bearer ${this.authStore.accessToken()}\` }`;
where that leaves an empty `headers` object or an unused `authStore`
injection, those go too. Some sites (e.g.
`notification-bell.ts:199`, `trip-search.ts:210`) have a private
`authHeader()` helper that is deleted outright.

`AuthApiService.fetchCurrentUser` is the one deliberate exception and
keeps its explicit header, per the escape hatch above.

## Edge cases

| Case | Expected behaviour |
|---|---|
| No session at all, request to a protected path | No header attached, `401` returned, no refresh attempted (there is no refresh token to present) |
| Refresh token expired (>7 days) | Refresh `401`s → session cleared → original `401` returned |
| Refresh token already blacklisted (rotation raced elsewhere, e.g. a second tab) | Same as above. Cross-tab refresh coordination is **not** solved here — see Failure modes |
| `401` from an anonymous endpoint (bad login password) | Passed straight through; login screens keep showing their own message |
| `401` on the refresh call itself | Never recursed into — the refresh path is on the excluded list |
| `403` (a permission the role lacks) | Untouched. Only `401` triggers refresh; conflating the two would refresh-loop on a legitimate permission denial |
| Request already carries an explicit `Authorization` | Left alone on the way out; on a `401`, still eligible for refresh-and-retry with the store's new token |
| `localStorage` unavailable / cleared mid-session | `restore()` already returns `null` defensively; the store behaves as signed out |
| Retry of a mutating request | Safe: the original `Idempotency-Key` header is part of the request object being replayed, so a retried `POST /bookings/` is deduplicated by `apps.core.idempotency` exactly as a client retry would be |

That last row is worth stating plainly, because an automatic retry of a
`POST` is otherwise alarming. It is safe **only** because every mutating
endpoint that takes an `Idempotency-Key` receives the identical one on
replay. It must stay that way; a middleware that regenerated the key on
retry would turn one booking into two.

## Failure modes

- **Multiple tabs — harmless as configured, dangerous if blacklisting is
  ever enabled.** Two tabs share `localStorage` but hold independent
  in-memory promises, so both can refresh at once. With
  `BLACKLIST_AFTER_ROTATION` off (see Data model changes) the loser's
  token is still valid and nothing breaks; each tab simply ends up
  holding a different, working refresh token. **Turn blacklisting on and
  this becomes random sign-outs**, which is why the two must be changed
  together. A cross-tab lock (`BroadcastChannel`, or a `storage`-event
  listener) is the fix when that day comes.
- **A call site that captures its `Authorization` header once and reuses
  it.** The middleware refreshes and retries correctly, but the *next*
  request built from the stale captured header 401s again and triggers
  another refresh — one per request instead of one per expiry. Observed
  live in `SelectedBusinessStore.fetchAllBusinesses`, which hoists
  `headers` above its paging loop. Not a middleware defect, and it
  disappears with the ad-hoc headers in Slice 2; noted because it makes
  refresh counts look wrong until then.
- **Clock skew.** The client never inspects token expiry; it reacts to
  a `401`. A skewed client clock therefore cannot cause a premature or
  missed refresh. This is deliberate — proactive expiry-timer refresh
  was considered and rejected as strictly more fragile than reacting to
  the server's own answer.
- **Refresh succeeds, retry fails on the network.** The new tokens are
  already persisted, so the session survives; the user retries the
  action. No rollback needed.
- **A longer access-token lifetime widens the theft window.** 60
  minutes is the accepted trade, per the decision taken for this arc.
  Revocation is still bounded by `REFRESH_TOKEN_LIFETIME` and by
  blacklist-after-rotation.

## Test plan

### Backend

Thin, matching the change:

- `ACCESS_TOKEN_LIFETIME` is 60 minutes — asserted against
  `settings.SIMPLE_JWT`, so the value cannot drift silently.
- A real login's access token carries a 60-minute window (`exp - iat`),
  proving the setting reaches an issued token and not just the config.
- An expired access token is rejected. Built already-expired via
  `AccessToken.set_exp` rather than moving the clock — this project has
  no time-travel test dependency and does not need one for this.
- `POST /auth/token/refresh/` returns a **new** refresh token.
- A rotated-away refresh token **still works** — pinning the current
  posture, weakness included, per the correction under Data model
  changes. This is a change-detector: installing the blacklist app flips
  it to `401` and fails here loudly, which is the moment to also solve
  the multi-tab race.

### Frontend

`@auth`, `auth.middleware.spec.ts`:

- Attaches the header when a session exists; attaches nothing when it
  does not.
- Does not overwrite an explicitly-supplied header.
- Excluded paths get no header and trigger no refresh.
- `401` → refresh → retry once with the **new** token → original
  request succeeds.
- `401` → refresh fails → `authStore.clear()` called, original `401`
  surfaced, no retry.
- Second `401` after a successful refresh is returned, not retried
  again (no loop).
- `403` never triggers a refresh.
- **Concurrency:** five simultaneous `401`s produce **exactly one**
  call to `/auth/token/refresh/`, and all five retry with the same new
  token. Asserted on the call count, not on timing.
- Rotation: the refresh response's `refresh` value is written to
  `AuthStore`, not just its `access`. (This is the failure mode that
  silently kills a session a day later, so it gets its own test.)

`auth-store.spec.ts`: `refreshToken` exposure, and `updateTokens()`
preserving `user` while replacing both tokens and re-persisting.

`api-client`, `api-client.token.spec.ts`: `provideApiClient` passes its
middleware factory through to `createApiClient`.

Regression: the existing suites of all four apps must stay green
through the header-removal slice — that is what proves the middleware
actually attaches what the call sites used to.

### E2E

Per-project (`--project=…`, never a bare `npx playwright test` — the
four projects interfere, see `docs/self-check-2026-08-26-spec11.md`):

- **Expiry recovery**, `client-admin-app`: sign in, overwrite the
  stored access token with an expired one, navigate to a list screen,
  assert the data still renders and that exactly one refresh request
  was made. This is the flow no unit test can prove end to end.
- **Hard expiry**, any app: corrupt both tokens, navigate, assert a
  redirect to `/login` rather than a hung empty state.

## Migration impact

None. No schema change, no backfill, no destructive step.

**Deployment note:** access tokens already issued under the 15-minute
setting remain valid for their original 15 minutes — the lifetime is
baked into each token at issuance, not read at validation. No session
is invalidated by the change; existing sessions simply keep their short
tokens until their next refresh.

## Suggested implementation slicing

Two slices, stop for review between.

**Slice 1 — the mechanism.** Backend settings value; `AuthStore`
additions; `auth.middleware.ts`; `provideApiClient` signature; wire it
into all four `app.config.ts`. Every existing ad-hoc header stays in
place and keeps working (the middleware's "don't overwrite an explicit
header" rule makes the two coexist). Ship it, and the refresh works
everywhere immediately.

**Slice 2 — the cleanup.** Remove the 89 attachments and their dead
helpers/injections. Purely mechanical, fully covered by the existing
suites, and safely revertible on its own because Slice 1 already
delivered the behaviour.

## Implementation note (Slice 1, done)

Built 2026-08-30. Backend 695/695 (up from 691); frontend 739 Karma
across the workspace, `auth` 47 (up from 25); all four apps build; ruff,
mypy and lint clean; `openapi.yaml` unchanged, as expected for a
settings-only backend change.

Three corrections to this spec came out of building it, each folded into
the section it belongs to above rather than listed only here:

1. **`BLACKLIST_AFTER_ROTATION` was a silent no-op** and the spec's
   security claim was wrong. Now `False` and honest. See Data model
   changes.
2. **`permissionGuard` cannot cover a mid-session logout** — it runs on
   route activation, and the route is already active. The middleware
   injects `Router` and navigates. See Logout on unrecoverable failure.
3. **`options.fetch(...)` as a method call breaks in every real
   browser** and in no unit test. See "Calling `fetch`: bare, never as a
   method".

(2) and (3) were found **only** by driving the flow in a real browser
against the running stack, after the whole unit suite was green. (3) in
particular passed 44/44 while being completely broken in Chrome, which
is the strongest argument this spec can offer for its own verification
step.

The single-flight property was verified the way this repo verifies
anything load-bearing: by breaking it deliberately (`??=` → `=`) and
confirming the test fails, then restoring.

**Live behaviour confirmed** on `client-admin-app`: three requests
expiring together produced exactly one `POST /auth/token/refresh/`, all
three retried, the screen rendered, and both tokens rotated in
`localStorage`. Killing the refresh token too produced a clean redirect
to `/login` rather than a hung screen.

One observation worth carrying into Slice 2: `SelectedBusinessStore
.fetchAllBusinesses` hoists its `Authorization` header above its paging
loop, so page 2 goes out with a token page 1 already proved dead —
producing a second refresh. The middleware handles it correctly; it is
just wasted work, and it is exactly the class of thing Slice 2 deletes.

## Implementation note (Slice 2, done)

Built 2026-08-30. **107 header attachments removed across 67 files**, 5
private `authHeader()` helpers, 7 `const authHeader` blocks, 2 hoisted
`const headers`, and **72 now-dead `AuthStore` injections** with their
imports. Exactly one hand-written `Authorization` remains, in
`AuthApiService.fetchCurrentUser`, with a comment saying why it is the
only one.

Frontend 739 Karma green, four clean builds, lint clean. E2E per
project: validator 7/7, customer 11/11, client-admin 68 passing.

**The slice found a real bug in Slice 1's middleware** — the
over-broad `/api/v1/staff/invitations/` anonymous prefix, described
under "Requests that must never get a header". Worth dwelling on: the
hand-written header had been *masking* a middleware defect for the whole
of Slice 1, and every unit test passed either way. It surfaced only as a
Playwright failure on staff invite. The fix prompted a full audit of
every prefix against the generated schema's real paths; nothing else was
over-broad, and `/api/v1/webhooks/` turned out to match no client path
at all (server-to-server), so it is kept only as a guard.

**The predicted outcome was verified**: the same expired-token scenario
that cost two refreshes in Slice 1 now costs exactly one, and
`businesses?offset=100` returns 200 instead of 401.

Three failures remain in the client-admin suite, none from this slice
and each attributed rather than assumed:

- `bookings.spec.ts` (trip dropdown) and `trips.spec.ts::filters the
  list by service date` — both **known-red before this arc**, from
  accumulated fixture data.
- `kyc-status.spec.ts` — the documented cross-project interference:
  `super-admin`'s `kyc-queue`, run earlier in the same session, approves
  the shared KYC fixture that this spec expects `submitted`. Confirmed
  by reading `Client.kyc_status` directly (`approved`), and the spec
  passes once the fixture is reset. Not an ordering problem within a
  run — the state lives in the shared database and persists across
  separate per-project runs.

A note for whoever runs e2e next: with the backend outside Docker,
`globalSetup` is skipped via `E2E_SKIP_SEED=1`, so `seed_e2e_users` must
be run by hand first. The validator ticket spec fails with "No unboarded
… ticket found" otherwise, because a previous run boarded the seeded one.
