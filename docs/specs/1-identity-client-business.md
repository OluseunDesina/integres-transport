# Phase 1: Identity, Client, Business

Status: **Complete — all 5 slices done.** Slice 1 (§10) — the RLS mechanism itself, proven against `TenancyProbe` — is done; see the implementation note at the end of §3 for three corrections found while building it. Slice 2 (Client self-registration + KYC, plus a real `client-admin-app` registration screen) is done; see the implementation note at the end of §2. Slice 3 (Business + KYB, backend-only) is done; see the implementation note at the end of §2 for a real Django/RLS interaction bug it caught. Slice 4 (Role/Permission/StaffInvitation, `/me` permissions array, frontend `PermissionsService` swap, and a retrofit of Slices 2–3's endpoints onto real per-permission gating) is done — see the implementation note at the end of §2. Slice 5 (WhiteLabelConfig, super-admin client-invitation flow, and the `GET /white-label/resolve/` subdomain resolution that closes Phase 0's gap) is done — see the implementation note at the end of §2.

Confirmed with you before writing this: Postgres Row-Level Security is added now (not deferred further), and RBAC is a DB-backed Role → Permission model (not hardcoded roles in code).

## 1. Scope and non-goals

**In scope:**
- Client self-registration (name, email, phone, password) and super-admin client-invitation flow, both converging on the same "create a Client + its owner User" service.
- Adding Businesses to a Client (vertical, currency, timezone, booking-mode default).
- KYC on Client, KYB per Business — document upload, super-admin review queue, per-document approve/reject with reason codes.
- Staff invitation and DB-backed RBAC (Role → Permission).
- White-label config (domain, logo, palette, email sender identity, terms) — and the subdomain-based Client resolution it unlocks, closing the gap Phase 0 left open.
- Audit log gets its first real callers (every privileged action below writes one).
- Postgres Row-Level Security as defense-in-depth alongside the existing ORM-level tenancy filter, applied to every tenant-owned table from this phase forward (see §3).

**Non-goals (explicitly deferred, not designed out):**
- Any Route/Trip/Schedule/Fare/Booking work — Phase 3/4.
- Payments, wallet, ledger — Phase 5. (Business's `currency`/`timezone` fields are added now since the brief locks them to Business, but no money moves yet.)
- Platform-side granular RBAC for super-admin staff — `is_platform_staff` remains an all-access flag for Phase 1, same as Phase 0. Worth revisiting once Integra has more than a handful of platform staff.
- Custom/user-editable roles — Phase 1 ships three fixed role presets per Client (Owner/Manager/Staff). Editable custom roles are a plausible v2 feature, not built now.
- KYC/KYB document content validation (OCR, fraud checks) — store + human review only.
- The super-admin app's actual UI for the review queues — Phase 2 per the brief's phase order. Phase 1 builds the backend endpoints and exercises them via API tests + Playwright hitting them directly, same pattern Phase 0 used for auth before any app had a real screen for it.

## 2. Data model changes

All new tenant-owned models inherit `apps.core.models.BaseModel` (UUID PK, `client` FK, timestamps, soft delete, RLS — see §3) unless noted otherwise.

### `apps.clients.Client` (extends the Phase 0 minimal model, additive)

New fields: `email` (unique), `phone`, `kyc_status` (`pending`/`submitted`/`approved`/`rejected`, default `pending`), `kyc_submitted_at`, `kyc_decided_at`, `kyc_decided_by` (FK to `identity.User`, null), `kyc_rejection_reason` (blank).

`Client` itself still has no `client` FK (it *is* the tenant) — RLS does not apply to it.

### `apps.businesses.Business` (new app)

`BaseModel` + `vertical` (`shuttle`/`intercity`/`metro`), `name`, `currency` (ISO 4217), `timezone` (IANA), `booking_mode_default` (`reservation`/`tap_and_go`), `kyb_status`/`kyb_submitted_at`/`kyb_decided_at`/`kyb_decided_by`/`kyb_rejection_reason` (same shape as Client's KYC fields), `is_active`.

**Flow, since the brief describes registration and "adding a Business" as separate capabilities**: registration creates the Client (KYC starts immediately). Adding a Business is a distinct, subsequent step — a Client can exist with zero Businesses transiently, but the client-admin UI (Phase 2+) should treat "add your first business" as the natural next screen after registration. KYB review can proceed independently of and concurrently with KYC review; a Business does not wait on Client KYC approval to exist, but `Business.kyb_status` gates Route/Trip creation later (Phase 3 concern, noted here so the field exists for it — see `docs/adr/0001` finding (d)).

### `apps.clients.KycDocument`

`BaseModel` + `document_type` (`certificate_of_incorporation`/`proof_of_address`/`directors_id`/`tax_certificate`/`other`), `file`, `status` (`pending`/`approved`/`rejected`), `reviewed_by` (FK `identity.User`, null), `reviewed_at`, `rejection_reason`.

### `apps.businesses.KybDocument`

Same shape as `KycDocument`, plus an explicit `business` FK (in addition to the inherited `client` FK, which is still what RLS/tenancy scopes on — `business` narrows to which Business within that Client the document is for).

### `apps.identity.Permission` (new, NOT a `BaseModel` — platform-wide, not tenant-owned)

`codename` (unique, e.g. `business.manage`), `description`.

Phase 1 seeds: `client.view`, `business.manage`, `kyb.submit`, `staff.invite`, `staff.manage`, `whitelabel.manage`. Every future phase adds its own codenames as it ships features that need gating — this table is append-only by convention, never redesigned.

### `apps.identity.Role`

`BaseModel` + `name` (e.g. `Owner`, `Manager`, `Staff`), `permissions` (M2M to `Permission`), `is_default_owner_role` (bool — marks which role a registering Client's first user gets).

Three rows auto-created per Client at registration (service-layer, not a migration data-fixture, since they're per-tenant): Owner (all Phase 1 permissions), Manager (`client.view`, `business.manage`, `kyb.submit`), Staff (`client.view` only). These are starting presets; Client owners cannot edit them in Phase 1 (non-goal above).

### `apps.identity.User` (extends the Phase 0 model, additive)

New field: `role` (FK to `Role`, null — set for `is_client_staff=True` users, irrelevant for passengers and platform staff).

### `apps.identity.StaffInvitation`

`BaseModel` + `email`, `role` (FK `Role`), `invited_by` (FK `User`), `token` (unique, `secrets.token_urlsafe`), `status` (`pending`/`accepted`/`revoked`/`expired`), `expires_at` (7 days from creation).

### `apps.clients.ClientInvitation` (super-admin → prospective Client, distinct from staff invitations)

**Not** a `BaseModel` — no Client exists yet when this row is created. `name`, `email`, `token`, `invited_by` (FK `User`, platform staff), `status`, `expires_at`.

### `apps.clients.WhiteLabelConfig`

`BaseModel`, one-to-one with the owning Client (`client` FK becomes effectively unique). `domain` (unique — the subdomain/custom domain this Client is reachable on), `logo`, `primary_color`, `secondary_color`, `email_sender_name`, `email_sender_address`, `terms_url`.

### `AuditLog` — no schema change, first real callers

Every endpoint in §4 marked **[audited]** calls `apps.core.audit.record_audit_event()`.

**Implementation note (Slice 2, built against this section)**: two deviations from the letter of this spec, both deliberate and labeled `ASSUMPTION:` before building rather than discovered after —

1. **`Client.email` uniqueness** shipped as `unique=True, null=True` in a single migration, not the nullable→backfill→constrain sequence §9 proposed. Postgres `UNIQUE` already permits unlimited `NULL`s, so Phase 0's no-email seed `Client` never collides with a real registered one — no backfill needed, same guarantee, less migration ceremony.
2. **Registration does not create the 3 default `Role` rows** this section describes, and the KYC upload endpoint is gated by the existing coarse `is_client_staff` flag (a new `IsClientStaff` DRF permission class), not the `client.view` permission column in §4's table. `Role`/`Permission`/`User.role` are still Slice 4 scope, unchanged from §10 — this just sequences Slice 2 to not depend on them early. Nothing here needs rework when Slice 4 lands; `register_client()` gets a `Role` assignment added to it then, additively.

Also: the super-admin decide endpoint (§4) decides only the **Client's overall KYC status** — not separate per-document approve/reject, despite this section's "per-document approve/reject too" phrasing. `KycDocument.status`/`reviewed_by`/`reviewed_at`/`rejection_reason` exist and are populated for context but aren't driven by their own endpoint yet; revisit if per-document review turns out to matter before Slice 3 wraps up KYB the same way.

**Implementation note (Slice 3, `Business`/`KybDocument`, built mirroring Slice 2's shape as §10 intended)**: the model/service/serializer layers really did mirror Slice 2 one-for-one — the two Slice 2 deviations above apply here unchanged (`IsClientStaff` instead of `business.manage`, no per-document KYB decisions). One **new** bug class surfaced here that Slice 2 never hit, worth recording since Slice 4/5 will write more list/detail views against `BaseModel` subclasses:

`queryset = Business.objects.all()` as a bare **class attribute** on a DRF generic view is evaluated once, at Python import time — before any request has ever set a tenancy context. `TenantScopedManager.get_queryset()` reads `get_current_client_id()` immediately (not lazily), so that one evaluation permanently froze to `.none()` (Client-less at import time = fails closed, per Slice 1's design) — every list/patch request against a real `Business` would 404 or return empty, forever, regardless of who asked. Caught immediately by the endpoint tests (list came back empty, patch 404'd) rather than surviving to the manual smoke test. Fixed by overriding `get_queryset()` as a **method** instead everywhere `.objects` (not `.all_objects`) backs a view's queryset — methods are called fresh per request, so the contextvar resolves correctly each time. `.all_objects`-backed querysets (the two super-admin queue views) aren't affected — `AllObjectsManager` never reads the contextvar, so evaluating it once at import time is harmless. This is now the pattern to follow for every future `IsClientStaff`-gated list/detail view: never `queryset = Model.objects...`, always `def get_queryset(self): return Model.objects...`.

**Implementation note (Slice 4, Role/Permission/StaffInvitation)**: built as planned, including the confirmed retrofit of Slices 2–3's endpoints onto real `HasPermission(codename)` checks (`apps.core.permissions`) in place of the coarse `IsClientStaff`. `ClientStaffUserFactory` grants Owner-equivalent access by default so the ~45 pre-existing Slice 2/3 tests kept passing with zero test-file changes — confirmed by running that suite before writing a single new Slice 4 test. Two real bugs the retrofit and its manual smoke test caught, not guessed:

1. `PrimaryKeyRelatedField(queryset=Role.objects.all())` on a serializer field has the exact same frozen-queryset failure mode as §2's Slice 3 note above, just on a serializer field instead of a view attribute — DRF's `SerializerMetaclass` evaluates declared field arguments once at class-body execution time too. Fixed the same way: resolve the `Role` manually inside `validate_role()` (a method, called per-request) instead of declaring a `queryset=` kwarg.
2. `platform_staff_bypass()` (new this slice, `apps.core.rls`) — a context manager granting the platform-staff RLS bypass for system code with no authenticated platform-staff request (resolving a `StaffInvitation` by its token; `create_default_roles` seeding a fresh Client before any staff session exists) — relies on `set_config(..., true)` (`SET LOCAL` semantics), which only survives the current transaction. That's true inside an HTTP request (`TenancyMiddleware` owns one) and inside `register_client()`'s explicit `atomic()`, but **not** true for a Celery task, which has no ambient transaction — in Postgres autocommit mode every statement is its own transaction, so the GUC was already gone by the next statement. Caught live: `send_staff_invitation_email` raised `StaffInvitation.DoesNotExist` against the real Docker stack despite passing every automated test (pytest's `django_capture_on_commit_callbacks` fixture runs the task inside the *test's* transaction, which masked exactly this gap). Fixed by having `platform_staff_bypass()` open its own `transaction.atomic()` whenever `connection.in_atomic_block` is false, rather than trusting every caller to remember — the same "own the transaction, don't rely on caller discipline" principle `TenancyMiddleware` was already built on in Slice 1.

**Implementation note (Slice 5, WhiteLabelConfig + ClientInvitation + subdomain resolution)**: `WhiteLabelConfig`/`ClientInvitation` were added to `apps.clients` rather than a new app — both are `Client`-adjacent and small enough not to justify one. `ClientInvitation` followed `Permission`'s precedent exactly: not a `BaseModel` subclass (no Client exists yet at invite time), so its resolve/complete flow needed **no** `platform_staff_bypass()` — its default manager carries no tenancy scoping to begin with, simpler than the `StaffInvitation` case specifically because of that "not a `BaseModel`" choice. `complete_client_invitation()` reuses `register_client()` unchanged (per §8's "shared service" requirement) and re-runs the duplicate-email check at completion time, not just at invite time — the same email could be registered directly via `/clients/register/` in the window between invite and complete; the check was factored into one shared `client_email_taken()` helper in `apps.clients.services`, used by both `ClientRegistrationSerializer` and `ClientInvitationCompleteSerializer`. `GET /white-label/resolve/` resolves via `request.get_host()` under `platform_staff_bypass()` (anonymous, cross-client by nature) — `ASSUMPTION:` this only reflects a real browser origin correctly when frontend and backend share a domain or a reverse proxy forwards `Host` unchanged; production reverse-proxy topology for white-labeled custom domains is out of scope for Phase 1, same "documented but unbuilt" treatment Phase 0 gave AWS provisioning. Frontend: `WhiteLabelResolverService` (new, `auth` lib) wired via `provideAppInitializer` into **both** `client-admin-app` and `customer-app` (the latter already existed from Phase 0 scaffolding, so §5's "once it exists" condition was already satisfied) — local dev has no matching domain, so resolution 404s and login falls back to the existing manual flow unchanged, confirmed by the full existing Playwright suite passing with zero new specs needed. This closes out Phase 1 — all 5 slices per §10 are now done.

## 3. Row-level security

Decided per your answer above: added now, not deferred. Mechanism:

1. **Session-variable-scoped policies.** Every concrete `BaseModel` subclass's table gets:
   ```sql
   ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON <table>
     USING (
       client_id = current_setting('app.current_client_id', true)::uuid
       OR current_setting('app.is_platform_staff', true) = 'true'
     );
   ```
   The `OR` clause is how platform staff (client-less JWTs) get legitimate cross-client access without a second database role/connection — it mirrors exactly the two session values `TenancyMiddleware` already resolves from the JWT in Phase 0, just also pushed into Postgres, not only into the Python contextvar.

2. **A reusable migration operation**, `apps.core.migration_operations.EnableRowLevelSecurity(model_name)`, wrapping the SQL above (plus its `RunSQL.reverse_sql` to drop the policy). Every future app's first migration for a new `BaseModel` subclass includes this operation — this is the "every future model" half of ADR-0002's consequence.

3. **`TenancyMiddleware` extended** to run, immediately after resolving `client_id`/`is_platform_staff` from the JWT and *inside* a transaction (see next point):
   ```python
   with connection.cursor() as cursor:
       cursor.execute("SET LOCAL app.current_client_id = %s", [client_id])
       cursor.execute("SET LOCAL app.is_platform_staff = %s", [str(is_platform_staff).lower()])
   ```

4. **`ATOMIC_REQUESTS = True`** on the database config. `SET LOCAL` only holds for the current transaction — outside an explicit transaction, Django's autocommit mode means the setting would vanish before any subsequent query runs. This is the one setting that makes the whole mechanism actually work, and it's also the one with a real cost: **every request now holds a transaction open for its full duration**, including whatever the view does before it touches the DB. Failure mode to watch: a slow external call (e.g. a future payment-provider webhook handler) inside a view holds a DB transaction open for that whole time. None of Phase 1's endpoints call anything slow, but this is flagged now so it's not forgotten when Phase 5 adds payment-provider calls.

5. **A registry-driven test** (`apps/core/tests/test_row_level_security.py`) iterates every concrete subclass of `BaseModel` via `apps.get_models()`, and for each one asserts (via a raw-SQL introspection query against `pg_class.relrowsecurity` and `pg_policies`) that RLS is enabled and the `tenant_isolation` policy exists. A new model that forgets the migration operation fails this test immediately — no allowlist to maintain, no exceptions (including `TenancyProbe`, which gets the same treatment).

6. **A sharper adversarial test**: with Client A's context set, issue a **raw SQL query** (bypassing the ORM manager entirely, e.g. `Model.objects.raw(...)` against the underlying table or a plain cursor) requesting Client B's known row by PK, and assert it comes back empty. This is the test that only RLS (not the Phase 0 manager-level filtering) can pass — it's the whole point of adding this layer.

**What this does not cover**: a Postgres superuser or a connection using `BYPASSRLS` still bypasses everything — RLS protects against application bugs, not against a compromised database credential. Out of scope for this phase.

**Implementation note (Slice 1, built against this section)**: three corrections to the SQL/mechanism sketched above, found by the adversarial test in §3.6 actually failing until each was fixed — recorded here rather than silently rewriting the sketch, since each is a real, non-obvious Postgres behaviour worth knowing before touching this code again:

1. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` alone does **not** apply the policy to the table's *owner* role. The app's DB role is the table owner (it ran the migration), so every query it issued was silently ignoring the policy — `pg_class.relrowsecurity` reads `true` throughout, giving no visible sign anything was wrong. `ALTER TABLE ... FORCE ROW LEVEL SECURITY` is required too; the registry test now also asserts `pg_class.relforcerowsecurity`.
2. Even with FORCE, this repo's docker-compose/CI Postgres role (`POSTGRES_USER`) turned out to be the initdb *bootstrap* role — a true superuser, and superusers bypass RLS unconditionally, FORCE notwithstanding, with no way to strip that attribute from a bootstrap role. Fixed by introducing a second, ordinary role (`integra_app`) that the backend and Celery worker connect as; the bootstrap role (`integra`) now exists only to provision it. See `docker/postgres/init-role-hardening.sql` and the note added to `docs/adr/0002`.
3. `client_id = current_setting('app.current_client_id', true)::uuid OR current_setting('app.is_platform_staff', true) = 'true'` crashes for an anonymous/platform-staff session: Postgres does not guarantee short-circuit evaluation of `OR` (documented behaviour, not a bug), so the `::uuid` cast on the left side still runs and raises even when the right side alone would make the row visible. Compounding it, `set_config(name, NULL, true)` on a custom GUC that's never been declared elsewhere returns an **empty string** from `current_setting`, not SQL `NULL` — so the cast always had something to fail on. Fixed with `NULLIF(current_setting(...), '')::uuid`, which normalizes to a real `NULL` before casting; `NULL = anything` is just `NULL` (excludes the row), never an error.

## 4. API surface

All under `/api/v1/`. **[audited]** = writes an `AuditLog` entry. Permission column names match §2's seeded codenames; `platform` means `is_platform_staff` required (Phase 1 has no platform-side granularity, per non-goals).

| Method & path | Auth | Permission | Audited | Purpose |
|---|---|---|---|---|
| `POST /clients/register/` | none | — | ✅ | Self-registration: creates Client + owner User + 3 default Roles, starts KYC (`pending`), returns client-admin tokens (auto-login) |
| `POST /super-admin/client-invitations/` | platform | platform | ✅ | Invite a prospective Client by name+email; sends email async via Celery |
| `GET /client-invitations/{token}/` | none | — | — | Resolve invitation → name/email for the completion form |
| `POST /client-invitations/{token}/complete/` | none | — | ✅ | Same as `register/`, pre-filled from the invitation; marks invitation accepted |
| `GET /businesses/` | client-admin | `client.view` | — | List own Client's Businesses |
| `POST /businesses/` | client-admin | `business.manage` | ✅ | Create a Business under the caller's Client; starts KYB |
| `PATCH /businesses/{id}/` | client-admin | `business.manage` | ✅ | Edit Business fields (not `kyb_status` — that's review-queue only) |
| `POST /clients/me/kyc-documents/` | client-admin | `client.view` | ✅ | Upload a KYC document (any authenticated client-staff can upload; review is platform-side) |
| `POST /businesses/{id}/kyb-documents/` | client-admin | `business.manage` | ✅ | Upload a KYB document for that Business |
| `GET /super-admin/kyc-queue/` | platform | platform | — | Clients with `kyc_status=submitted`, plus their documents |
| `POST /super-admin/kyc-queue/{client_id}/decide/` | platform | platform | ✅ | Approve/reject Client KYC (body: `decision`, `reason` if rejected); per-document approve/reject too |
| `GET /super-admin/kyb-queue/` | platform | platform | — | Businesses with `kyb_status=submitted` |
| `POST /super-admin/kyb-queue/{business_id}/decide/` | platform | platform | ✅ | Approve/reject Business KYB |
| `GET /staff/roles/` | client-admin | `client.view` | — | List own Client's 3 roles + their permissions (for an invite-staff role picker) |
| `POST /staff/invitations/` | client-admin | `staff.invite` | ✅ | Invite staff by email+role; sends email async |
| `GET /staff/invitations/{token}/` | none | — | — | Resolve invitation → Client name + Role name for the accept form |
| `POST /staff/invitations/{token}/accept/` | none | — | ✅ | Create the staff User, mark accepted, auto-login (client-admin tokens) |
| `GET /staff/` | client-admin | `staff.manage` | — | List own Client's staff users + roles |
| `PATCH /staff/{user_id}/` | client-admin | `staff.manage` | ✅ | Change a staff member's role, or deactivate |
| `GET /white-label/` | client-admin | `whitelabel.manage` | — | Own Client's config |
| `PATCH /white-label/` | client-admin | `whitelabel.manage` | ✅ | Edit domain/branding/sender identity/terms |
| `GET /white-label/resolve/` | none | — | — | **Resolve by `Host` header**, not path/query — returns `{client_id, name, logo, primary_color, ...}` or 404. This is what closes Phase 0's subdomain-resolution gap (§5) |

`MeSerializer` (existing endpoint, extended): adds `permissions: string[]` — passengers get `["customer:access"]`, platform staff get `["super-admin:access"]`, client staff get `["client-admin:access", ...role.permissions.codename]`. This is additive to the response shape; no breaking change to the Phase 0 contract.

## 5. Closing Phase 0's subdomain-resolution gap

Phase 0's login serializers accept an optional `client` UUID field as a stand-in for real subdomain resolution (documented in `apps/identity/serializers.py`). Phase 1 doesn't remove that field (still useful for local dev against `localhost`, and as a fallback), but the **client-admin app** and (once it exists) the **customer app** now call `GET /white-label/resolve/` on boot, using the browser's actual `Host` header, and pre-fill/auto-set the `client` field from the result — a real user on `acme.integra-afc.com` never sees or needs to know a UUID. Frontend change: a new `WhiteLabelResolverService` in the `auth` lib, called from each app's `app.config.ts` via an `APP_INITIALIZER`-equivalent (Angular's `provideAppInitializer`), populated before the router activates the login route.

Local dev (`localhost:4200` etc.) has no matching `WhiteLabelConfig` domain, so resolution 404s and the app falls back to the existing manual `client` field — this is the same graceful degradation Phase 0 already documented, not a new special case.

## 6. Edge cases

- **Registering with an email that already exists as a Client's contact email**: `Client.email` is globally unique (unlike `User.email`, which is scoped) — reject with a clear "a Client with this email already exists" error, not a generic 500.
- **KYC/KYB re-submission after rejection**: rejecting sets `status=rejected` with a reason; the Client/Business can upload new documents, which should transition status back to `submitted` (not stay `rejected`) once at least one new document is uploaded — service-layer logic, not automatic on every upload (a single re-uploaded document while others remain doesn't necessarily mean "ready for re-review," but Phase 1 keeps this simple: any new document upload while `status=rejected` flips it back to `submitted`).
- **Staff invitation to an email that's already staff at that Client**: reject (`already a member`), don't silently re-invite.
- **Staff invitation to an email that's already staff at a *different* Client**: allowed — `User` uniqueness is scoped per Client (Phase 0 decision), so the same person can legitimately work for two Clients with two separate accounts.
- **Expired invitation (staff or Client) accepted**: reject with a clear "this invitation has expired" error, not a generic 404/500. `status` transitions to `expired` lazily on access (checked against `expires_at`), not via a scheduled task.
- **Revoked invitation link reused**: same as expired — clear rejection, not a silent no-op.
- **Business created for a Client whose own KYC is still `pending`**: allowed (§2's Flow note) — KYB review doesn't block on KYC approval, though a real product decision about whether a Business can go *live* (start taking bookings, Phase 3+) without Client KYC approval is out of scope here and should be decided in the Phase 3 spec.
- **`whitelabel.resolve` called for a `domain` whose Client has `kyc_status != approved`**: still resolves (branding should work during onboarding demos) — this endpoint is about branding resolution, not an access gate.
- **Two Businesses under the same Client requesting the same `vertical`**: allowed — nothing in the brief says one-Business-per-vertical-per-Client (e.g. a Client might run two separate shuttle Businesses in two cities). Flagged as an assumption; revisit if wrong.

## 7. Failure modes

- **RLS session variables not set** (e.g. a management command or Celery task touching the DB outside the request/middleware path): the `OR is_platform_staff` clause doesn't help here since neither session variable is set at all — `current_setting(..., true)` returns `NULL` for an unset variable, and `client_id = NULL` is never true in SQL, so **the policy fails closed** (zero rows visible), not open. This is the correct failure direction for a security control, but it means every management command and Celery task that needs tenant data must explicitly set these session variables itself (or run through `all_objects` deliberately) — documented in `CLAUDE.md`, and the `seed_e2e_users` pattern from Phase 0 already does exactly this shape of thing (bypasses tenancy deliberately, explicitly, via `all_objects`, not by accident).
- **Invitation email fails to send** (Celery/SMTP failure): the invitation row is still created (not rolled back) — a super-admin/client-admin can see it exists and the UI (later phase) can offer a "resend" action. The endpoint response should not fail just because the async email dispatch fails; log the Celery failure, don't 500 the request.
- **Concurrent KYC decisions** (two platform staff reviewing the same Client simultaneously): last-write-wins is acceptable for Phase 1 (low volume, human-paced), but the decide-endpoint should use `select_for_update()` to avoid a lost-update race producing an inconsistent `kyc_status`/`kyc_decided_by` pair.
- **`ATOMIC_REQUESTS` interaction with the existing throttle/cache code**: throttle checks happen before the view (and before RLS session variables are set, since throttling doesn't need tenant data) — no interaction, but worth a regression test given both mechanisms now sit in the request lifecycle.

## 8. Test plan

Backend, mandatory per the brief's testing bar plus this phase's own additions:
- Cross-client isolation, **now via RLS**, not just the Phase 0 manager test — the raw-SQL adversarial test from §3.6, run against `Business` and `KycDocument`/`KybDocument`, not just the diagnostic probe.
- Registry-driven RLS-completeness test (§3.5).
- Registration → KYC pending → document upload → super-admin approve → status flips, each step audit-logged (assert `AuditLog` rows, not just status fields).
- Registration → reject → resubmit → re-approve.
- Client self-registration and invitation-completion produce identical Client/User/Role state (shared service, tested once per entry point, asserting the same outcome).
- Staff invitation → accept → new User has correct `role`, `is_client_staff=True`, correct `client`.
- Staff invitation edge cases from §6 (expired, revoked, duplicate).
- Permission enforcement: a `Staff`-role user gets 403 on `business.manage`-gated endpoints; a `Manager` succeeds; a user from Client A gets 403 (not 404, to avoid leaking existence — actually reconsider: RLS means Client A's queryset can't even see Client B's Business row, so this is a 404 by construction, not a 403 — call this out explicitly in the endpoint tests so the distinction is deliberate, not accidental).
- `white-label/resolve/` — valid domain, unknown domain (404), and confirm it does **not** require authentication (it's the thing that runs *before* login).
- `/me` returns the correct `permissions` array for all three user kinds (passenger/client-staff/platform-staff).

Frontend:
- `WhiteLabelResolverService` unit tests (resolves, 404-falls-back).
- `PermissionsService` updated to source from `/me`'s `permissions` array instead of deriving synthetic strings — unit tests updated accordingly (this changes existing Phase 0 behavior, flagged so it's reviewed as a deliberate change, not a silent regression).

E2E (Playwright, real stack): client self-registration → business added → KYC+KYB documents uploaded → super-admin approves both (exercised via API since the super-admin UI doesn't exist until Phase 2, same pattern as Phase 0) → client signs in and sees approved status. Staff invitation → accept → new staff member signs in with role-appropriate permissions visible/enforced.

## 9. Migration impact

All additive except:
- `Client.email` unique constraint — **additive but needs a backfill plan**: Phase 0 seeded a `Client` (via `seed_e2e_users`) with no email. This migration must either backfill a placeholder email for pre-existing rows or the constraint will fail to apply in any environment that ran Phase 0's seed command. Recommend: nullable `email` initially, backfill, then a follow-up migration adding the `NOT NULL unique` constraint — the zero-downtime discipline the brief requires, called out explicitly rather than done as one migration.
- RLS `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` — additive/reversible (the custom operation's `reverse_sql` disables it), but this is exactly the kind of migration the brief wants flagged before running: **it changes query behavior for every existing row**, not just schema shape. Flagging here for your explicit awareness before this phase is approved, even though it's not "destructive" in the delete-data sense.

## 10. Suggested implementation slicing

Per the working agreement (thinnest vertical slice, stop for review), proposed order within this approved phase:
1. RLS mechanism + registry test, applied retroactively to Phase 0's `TenancyProbe` first (proves the mechanism against something trivial before real models depend on it). **Done.**
2. Client self-registration + KYC (Client extension, KycDocument, super-admin KYC queue, audit log's first real use) — demoable end-to-end slice. **Done.**
3. Business + KYB (mirrors step 2's shape). **Done.**
4. Role/Permission/StaffInvitation + `/me` permission array + frontend `PermissionsService` change. **Done.**
5. WhiteLabelConfig + subdomain resolution + super-admin client-invitation flow (the two remaining pieces, lower risk, can land together). **Done — Phase 1 complete.**

Each still gets its own stop-and-review per your working agreement — this is a proposed order, not a request to build all five in one pass.
