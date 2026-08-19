# Deployment and migration plan

Operational runbook for standing up Integra AFC on real infrastructure and
for how database migrations get handled from that point on. This is not a
spec for new product behavior and not a PRD — it describes how to take the
system that already exists (Phases 0–6, all complete per
`docs/architecture.md`) and put it somewhere reachable outside a laptop.

## 0. Scope and assumptions

- **Target platform: Vercel + Supabase.** Backend and each of the 4
  frontends deploy as **5 separate Vercel projects** against this one
  repo; Postgres is a Supabase project. Chosen for a fast, effectively
  free path to a URL other people can actually click, over Render (more
  persistent-process ceremony for a demo) or AWS (far more provisioning
  work than this stage needs).
- **ASSUMPTION**: this plan stands up **one shared, hosted environment**
  ("dev" — reachable by anyone with the URL, not customer-facing, not
  yet held to production data-safety guarantees), not a staging/production
  split. Every step below is written for that one environment. A real
  staging+production split is a separate, later piece of work — not
  designed here.
- **Out of scope by explicit choice**: CI/CD automation. Every step is a
  manual action (Supabase dashboard/SQL editor, Vercel dashboard, or a
  local terminal). The existing `.github/workflows/ci.yml` still only
  runs tests; the two new GitHub Actions workflows this plan uses
  (§1.1) exist purely to replace Celery Beat's schedule, not as a
  deploy pipeline.
- **Vercel runs no persistent process** — no Celery worker, no Celery
  beat, no Redis. This is the one structural way this target differs
  from a conventional container host, and it shapes §1, §1.1, and half
  of §3.
- **Read `docs/adr/0002` (RLS) and `docs/adr/0007` (Paystack) before
  running this** — this plan assumes their content rather than
  re-explaining it.

## 1. Target architecture on Vercel + Supabase

| Local (`docker-compose.yml`) | Vercel/Supabase equivalent | Notes |
|---|---|---|
| `backend` | Vercel project (Python builder) | `backend/vercel.json` + `backend/api/index.py` (both already in the repo) — routes every request to a WSGI entrypoint that hardcodes `DJANGO_SETTINGS_MODULE=config.settings.vercel`. No gunicorn/uwsgi needed — Vercel's Python runtime is itself the WSGI server. |
| `celery-worker` | *(none)* | `config/settings/vercel.py` sets `CELERY_TASK_ALWAYS_EAGER = True` — the two `.delay()` call sites (`send_client_invitation_email`, `send_staff_invitation_email`) run synchronously in-process instead, no code change needed at either call site. |
| `celery-beat` | *(none — see §1.1)* | The two periodic jobs (`generate_trips`, `expire_seat_holds`) move to authenticated HTTP endpoints triggered by external schedulers, not a long-running beat process. |
| `postgres` | Supabase project | Needs `btree_gist` + the same non-superuser `integra_app` role this project uses everywhere else — see §4.1. Runtime traffic goes through Supabase's Supavisor pooler (transaction mode, port 6543); migrations use the direct connection (port 5432). |
| `redis` | *(none)* | Confirmed by grep before this plan was written: nothing in application code uses Django's cache framework — `config/settings/vercel.py` sets `CACHES` to `LocMemCache`. Redis was only ever Celery's broker/result backend, and Celery isn't running here. |
| *(none — static build output only)* | 4× Vercel project (Angular) | `customer-app`, `client-admin-app`, `super-admin-app`, `validator-app`, each its own Vercel project against this same repo. Root Directory `frontend` for all 4 (that's where `angular.json` lives); Build Command override `npx ng build <project> --configuration=production`; Output Directory override `dist/<project>/browser` (confirmed — Angular's `@angular/build:application` builder's real output shape in this repo). Framework Preset "Angular" so Vercel applies the SPA history-mode fallback (deep-link refresh → `index.html`) automatically — no `vercel.json` needed on the frontend side. |

### 1.1 Celery Beat replacement — already built

Two authenticated internal endpoints stand in for the two Celery Beat
jobs, both in `apps/core/views.py` (`GenerateTripsView`/
`ExpireSeatHoldsView`, mounted at
`POST /api/v1/internal/tasks/generate-trips/` and
`.../expire-seat-holds/`): `AllowAny` + no DRF authentication classes,
gated instead by an `X-Internal-Task-Secret` header checked with
`hmac.compare_digest` against `settings.INTERNAL_TASK_SECRET` — the same
shape `apps.payments.views.PaystackWebhookView` already established for
"a real external caller with no Django user behind it." Both are
`@extend_schema(exclude=True)`, matching that same webhook view's
precedent for keeping internal-only endpoints out of the generated
OpenAPI schema.

Two GitHub Actions cron workflows call them:

- `.github/workflows/expire-seat-holds-cron.yml` — every 5 minutes
  (`*/5 * * * *`), standing in for that job's real ~1-minute Celery Beat
  cadence closely enough to behave visibly correctly.
- `.github/workflows/generate-trips-cron.yml` — once daily, `30 2 * * *`
  UTC.

Both read `BACKEND_URL` and `INTERNAL_TASK_SECRET` as GitHub repo
secrets, set once the real values are known (§4.3). **Neither workflow
uses Vercel's own native Cron Jobs**, deliberately: Vercel Cron always
sends a plain `GET` with no custom headers (only its own reserved
`Authorization: Bearer $CRON_SECRET` convention) — these endpoints are
`POST`-only and check a custom header, so adopting native Vercel Cron
would mean a second auth convention and a new HTTP method for one
endpoint. Reusing GitHub Actions for both keeps one mechanism for both
jobs.

## 2. Pre-deploy code changes required

Much shorter than a conventional-host version of this plan: Vercel's
Python runtime *is* the production WSGI server, so there's no
`runserver`-in-production gap to fix here the way a Docker/VPS target
would have.

1. **`backend/requirements.txt` must exist and stay current.** Vercel's
   Python builder doesn't understand `uv`/`pyproject.toml` — it wants a
   plain `requirements.txt`. Already generated once
   (`uv export --no-dev --format requirements-txt -o requirements.txt`,
   71 pinned packages with hashes) and committed. **Regenerate it with
   that same command before any deploy where `uv.lock` changed** —
   nothing automates this, matching this plan's "runbook only" CI/CD
   scope (§0).
2. **The 4 frontend apps' `apiBaseUrl` placeholders are still
   unset for real.** Every app's
   `src/environments/environment.production.ts` currently ships the
   Phase-0 placeholder `https://api.integra-afc.example.com` — this is
   baked in at build time via `fileReplacements`, not a runtime env var
   (`api-client`'s `provideApiClient()` just takes whatever
   `environment.apiBaseUrl` each app's `app.config.ts` passes it). This
   can't be filled in until the backend Vercel project exists and its
   URL is known — same chicken-and-egg §4.3/§4.6 below resolve in
   order.

No other pre-deploy code change is required.

## 3. Secrets and environment variables

All vars below live on the **one** backend Vercel project — there's no
separate worker/beat service to duplicate them onto, unlike a
conventional-host deployment.

| Var | Format | Where it comes from | Boots-crash if unset? |
|---|---|---|---|
| `DJANGO_SECRET_KEY` | opaque random string | Generate fresh — `python -c "import secrets; print(secrets.token_urlsafe(64))"` | **Yes** |
| `DJANGO_ALLOWED_HOSTS` | comma-separated hostnames | The backend Vercel project's assigned hostname (`<project>.vercel.app`) | No (defaults `""`, but an empty list makes every request 400 — effectively required) |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_HOST` / `POSTGRES_PORT` | — | Supabase's **Supavisor pooler, transaction mode** connection info (port 6543, host `aws-0-<region>.pooler.supabase.com`, username formatted `<role>.<project-ref>`) — **must be `integra_app`'s credentials (or the verified fallback role, §4.1), not Supabase's own `postgres` role**, for the same RLS reason every other environment here insists on it | No default is dangerous by itself, but connecting as the wrong role silently defeats RLS |
| `CORS_ALLOWED_ORIGINS` | comma-separated origins | The 4 frontend Vercel projects' URLs once known (§4.6) | No default, but empty means every frontend request gets blocked by CORS |
| `CLIENT_ADMIN_APP_URL` | URL | The `client-admin-app` Vercel project's real URL (used in staff-invitation accept links) | No (has a `localhost:4201` default that would silently produce broken invite emails) |
| `INTERNAL_TASK_SECRET` | opaque random string | Generate fresh — same command as `DJANGO_SECRET_KEY`. Also set as a **GitHub Actions repo secret**, shared by both cron workflows (§1.1) | No (empty-string default, but the view's own guard rejects an empty-secret/empty-header match, so an unset value just makes both cron jobs permanently 403 rather than silently succeeding) |
| `PAYSTACK_SECRET_KEY` | `sk_test_...` (this environment) | Paystack dashboard, **test mode** — this is a shared "dev" environment, not real production | **Yes** |
| `PAYSTACK_WEBHOOK_SECRET` | same value as `PAYSTACK_SECRET_KEY` | Paystack signs webhooks with the same secret used for API calls — see `apps/payments/psp/paystack.py`'s own comment | **Yes** |
| `INTEGRA_COMMISSION_RATE_PERCENT` | decimal, e.g. `5.00` | A real business decision, not a technical one | **Yes** |
| `TICKET_SIGNING_KEYS` | JSON string: `{"<kid>": "<base64 Ed25519 private key>"}` | Generate — see §4.2 | **Yes** |
| `TICKET_SIGNING_ACTIVE_KID` | string, must match a key in `TICKET_SIGNING_KEYS` | Chosen alongside the key above, e.g. `dev-2026-08-1` | **Yes** |
| `TICKET_VALID_BEFORE_MINUTES` / `TICKET_VALID_AFTER_MINUTES` | int | Defaults (`1440`/`240`) are fine to leave unset unless the business wants different windows | No |

`DJANGO_SETTINGS_MODULE` is **not** set here — `backend/api/index.py`
hardcodes `config.settings.vercel` as its own default, the same way
`config/wsgi.py` hardcodes `config.settings.local` for its own.
`REDIS_URL` doesn't appear at all on this target (§1).

## 4. First-deploy runbook

### 4.1 Provision Supabase and verify the app role

1. Create a Supabase project (note the DB password shown at creation —
   shown once).
2. SQL Editor: `CREATE EXTENSION IF NOT EXISTS btree_gist;` — confirmed
   safe, a "trusted" extension since Postgres 13, installable without
   superuser.
3. **Verify before assuming** (same posture this plan has always taken
   for the app-role step): check the connected role's privileges —

   ```sql
   SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user;
   ```

   If `rolcreaterole` is true, create the same non-superuser role every
   other environment in this repo uses:

   ```sql
   CREATE ROLE integra_app LOGIN PASSWORD '<a real generated password>' NOSUPERUSER NOBYPASSRLS;
   GRANT ALL ON DATABASE postgres TO integra_app;
   ```

   If `CREATEROLE` isn't available on the plan/project, the fallback is
   connecting as Supabase's own `postgres` role directly — accept this
   as a **named, not silently assumed** gap (§7): RLS's second-layer
   defense loses some value if the connecting role turns out to carry
   bypass privileges, the same concern `docs/adr/0002` raises about a
   Postgres superuser connection generally.
4. Note both connection forms from the Supabase dashboard's "Connect"
   panel — the **direct connection** (port 5432, `db.<ref>.supabase.co`)
   for migrations (§4.4), and the **Supavisor pooler, transaction mode**
   (port 6543) for the deployed app's `POSTGRES_*` env vars (§3).

### 4.2 Generate the Ed25519 ticket-signing keypair

Unchanged from any other target — platform-agnostic. No tooling exists
for this anywhere in the repo (the only place `SigningKey.generate()`
appears is a test helper), it's a one-off:

```bash
python -c "
from nacl.signing import SigningKey
from base64 import b64encode
key = SigningKey.generate()
print(b64encode(bytes(key)).decode())
"
```

Pick a `kid` (e.g. `dev-2026-08-1` — include a date so a future rotation
has an obvious naming convention to follow), and set:

```
TICKET_SIGNING_KEYS={"dev-2026-08-1": "<the base64 output above>"}
TICKET_SIGNING_ACTIVE_KID=dev-2026-08-1
```

Store the raw key somewhere safe outside Vercel too (a password
manager) — losing it means every already-issued ticket's QR becomes
unverifiable, with no recovery path (see ADR-0005).

### 4.3 Create the backend Vercel project

Root Directory `backend`, against this repo — Vercel's Python builder
picks up `backend/vercel.json` + `backend/api/index.py` +
`backend/requirements.txt` automatically. Set every var from §3. Note
the project's assigned URL (`https://<project>.vercel.app`) — it's
known as soon as the project exists, even before the first successful
deploy, and every cross-referencing env var (`CORS_ALLOWED_ORIGINS`,
`CLIENT_ADMIN_APP_URL`, each frontend's `apiBaseUrl`, §4.6) depends on
knowing it up front, the same "name things deliberately before you need
them" reasoning any multi-service deploy needs.

### 4.4 Run the first migration, then seed

From a local machine (there's no Vercel Shell/one-off-job equivalent —
migrations run against Supabase's **direct** connection, not through
the deployed app):

```bash
cd backend
POSTGRES_HOST=db.<ref>.supabase.co POSTGRES_PORT=5432 POSTGRES_USER=integra_app \
POSTGRES_PASSWORD=<value> POSTGRES_DB=postgres \
DJANGO_SETTINGS_MODULE=config.settings.vercel \
DJANGO_SECRET_KEY=<value> TICKET_SIGNING_KEYS=<value> TICKET_SIGNING_ACTIVE_KID=<value> \
INTERNAL_TASK_SECRET=<value> \
  uv run python manage.py migrate
```

This also seeds the (now-unused-by-Celery-Beat-but-still-present)
`generate_trips`/`expire_seat_holds` periodic-task rows via
`apps/scheduling/migrations/0002_...`/`apps/seating/migrations/0002_...`
— harmless; nothing reads `django_celery_beat_periodictask` on this
target since there's no beat process to read it (§1).

The one destructive migration in this codebase's history
(`apps/fares/migrations/0002_version_fare_rules.py`, documented in
`docs/specs/4-fares-seating-booking-versioning.md` §7) is a non-issue
here: it already ran against the *existing dev database* on record for
history. A brand-new Supabase database has no data to lose — `migrate`
just runs the full sequence cleanly on an empty schema.

Then, same environment variables, run:

```bash
uv run python manage.py seed_e2e_users
```

This makes the accounts and fixtures `docs/test-catalog.md` (the
manual UAT guide) assumes — `e2e-passenger@example.com`,
`e2e-client-staff@example.com`, the bookable Ikeja→CMS Business, the
tap-and-go CBD Loop Business with its fixed known token, etc. — real
against this deployment, not just local dev.

### 4.5 Register the Paystack webhook

Not documented anywhere else in this codebase — a real manual step. In
the Paystack dashboard (test mode, matching the test secret key from
§3), set the webhook URL to:

```
https://<your-backend-project>.vercel.app/api/v1/webhooks/paystack/
```

(confirmed exact mount — `config/urls.py` includes `apps.payments.urls`
under the `api/v1/` prefix, and `apps/payments/urls.py` itself defines
`webhooks/paystack/`).

### 4.6 Update the frontend API URLs, then create the 4 frontend Vercel projects

Edit each app's
`frontend/projects/<app>/src/environments/environment.production.ts`'s
`apiBaseUrl` from its current placeholder to the real backend URL from
§4.3 — bare origin, no `/api/v1` suffix (`api-client` appends that
itself), matching the format `environment.development.ts` already uses
for local dev (`http://localhost:8000`). Commit this change before
building any frontend project, since it's baked in at build time.

Create 4 Vercel projects, one per app, all rooted at `frontend`, per
§1's table (Framework Preset Angular, Build Command
`npx ng build <project> --configuration=production`, Output Directory
`dist/<project>/browser`). Once all 4 URLs are known, go back and set
`CORS_ALLOWED_ORIGINS`/`CLIENT_ADMIN_APP_URL` on the backend project
(§3) and redeploy it.

### 4.7 Known, accepted gap for this deploy: unstyled API docs

No `whitenoise`/static-file serving is configured — Vercel's Python
builder has no generic build-script hook the way its Node builder does
to run `collectstatic`, and this deployment exists to demo the API and
the 4 frontends, not the Django admin. `GET /api/v1/docs/` (Swagger UI)
and the DRF browsable API will load and function but render unstyled
(no CSS). Named, not solved — same posture every other out-of-scope gap
in this codebase gets (§7).

## 5. Migration plan (ongoing, after the first deploy)

- **Every subsequent deploy that includes a migration**: run it the
  same way §4.4 did the first one — from a local machine, against
  Supabase's direct connection, `DJANGO_SETTINGS_MODULE=config.settings.vercel
  uv run python manage.py migrate`, before (or immediately after)
  pushing the code that depends on it. There's no Vercel equivalent of
  a "pre-deploy command" hook the way Render/similar PaaS platforms
  offer for this — it stays a manual step on this target specifically.
- **No rollback tooling exists for migrations in this codebase**, and
  Django's own reverse-migration capability (`migrate <app> <previous>`)
  is untested here. The real safety net is discipline, not tooling:
  always deploy code and its migration together (never a migration
  alone, never code alone that depends on a migration that hasn't run
  yet), and once this environment holds data anyone cares about, prefer
  additive migrations (add a nullable column → deploy code that writes
  it → backfill → tighten the constraint in a later migration) over one
  migration that changes and immediately depends on the change.
  Zero-downtime migration discipline isn't strictly needed yet for a
  "dev" environment with no real users, but is worth adopting before
  this ever becomes production.
- **The fares-versioning destructive migration** (§4.4) needs no
  special handling going forward — it's a closed historical event on
  the existing dev database, irrelevant to a fresh Supabase database
  and to migrations written from here on.
- **`backend/requirements.txt` staleness** is a migration-adjacent risk
  worth restating here: if a deploy changes `uv.lock` and
  `requirements.txt` isn't regenerated first (§2), Vercel will build
  with stale/missing dependencies, not fail loudly at migrate time —
  check this before every deploy that touched `backend/pyproject.toml`.

## 6. Post-deploy verification

Not a full smoke-test script — just enough to confirm the deploy
actually works before calling it done:

1. `GET https://<backend>.vercel.app/api/v1/health/` → `200`.
2. `POST .../internal/tasks/expire-seat-holds/` with the correct
   `X-Internal-Task-Secret` → `200`; with a wrong or missing header →
   `403`. Same for `.../internal/tasks/generate-trips/`. (This target's
   equivalent of "confirm Celery Beat is actually scheduled" — there's
   no beat process to inspect, so the endpoints themselves are what's
   being verified.)
3. Register a Client via `POST /clients/register/` (or the
   `customer-app` registration screen) — confirms migrations ran and
   the DB connection (as `integra_app`, not Supabase's default role)
   works.
4. Confirm RLS is actually active, not silently bypassed: create two
   Clients, confirm a JWT scoped to one can't read the other's data
   through any list endpoint. If this fails, the most likely cause is
   §4.1's role setup not having actually applied (e.g. the app is still
   connecting as Supabase's own `postgres` role).
5. Run a full booking → pay → ticket → validate round trip end to end
   (`customer-app` → Paystack test-mode checkout → webhook fires →
   booking marked paid → ticket issued → `validator-app` validates it)
   — exercises the Postgres connection, both internal-task endpoints
   indirectly (seat-hold expiry logic), and the Paystack webhook
   registration (§4.5) all at once.
6. Spot-check 2–3 entries from `docs/test-catalog.md` directly against
   the live URLs — the seeded accounts from §4.4 make this immediately
   possible, no additional setup needed.

## 7. Known gaps not resolved by this plan (named, not solved)

- **Unstyled API docs / no static-file serving** (§4.7) — accepted for
  this demo environment.
- **Supabase's exact `CREATEROLE` privilege** (§4.1) — the plan's SQL is
  the right SQL, sourced from this repo's own CI provisioning step, but
  whether Supabase's default project role can execute it wasn't
  confirmed against Supabase's own documentation while writing this
  plan. Verify live as the very first step of a real deploy attempt;
  the fallback (connecting as Supabase's own `postgres` role) is named
  in §4.1, not silently substituted.
- **Media storage** — `MEDIA_ROOT` is still local disk
  (`backend/config/settings/base.py`), and Vercel's filesystem is
  ephemeral per-invocation, meaningfully worse than Render's for this
  purpose (not just "not guaranteed to persist across deploys" but
  effectively per-request). Uploaded KYC/KYB documents will not persist
  at all on this target — **do not accept this for anything beyond a
  demo**; a real environment needs S3 + `django-storages` added as its
  own piece of work first.
- **CI/CD automation** — explicitly out of scope this pass (§0).
- **Staging/production split** — this plan stands up one environment;
  designing a split is separate, later work.
- **The pre-existing bare-`config()`-secret CI gap** CLAUDE.md already
  flags (`SECRET_KEY`/`PAYSTACK_SECRET_KEY` crashing settings import
  when CI sets no env vars) is unrelated to this plan and still
  unfixed — it's a testing-environment gap, not a deployment one.
- **Botswana Paystack coverage** (`docs/adr/0007`) — pre-existing,
  unrelated to this plan, still an open gap for that specific market
  regardless of hosting platform.
